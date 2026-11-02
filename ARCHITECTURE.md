# Architecture

## Overview

**Wagering** é um sistema de processamento de transações de apostas com garantia de idempotência e consistency, construído para lidar com falhas entre componentes sem perder ou duplicar débitos.

O sistema é composto de dois serviços:
- **API** (`src/main.ts`): NestJS application que expõe endpoints HTTP para criar wallets e processar transações
- **Worker** (`src/worker.ts`): NestJS application que consome mensagens de SQS e publica eventos

Ambos compartilham a lógica de negócio via `CoreModule`, mas rodam em processos separados.

## Architecture Pattern: Outbox & Inbox

O sistema usa dois padrões para garantir consistency:

### 1. Transactional Outbox Pattern (API → SQS)

Quando uma transação de aposta é processada:
1. **API** valida a aposta e persiste a transação no Postgres **em uma única transação**:
   - Cria `WagerTransaction` (status = PENDING)
   - Débita da wallet (ledger entry)
   - Insere mensagem na tabela `outbox_messages` (não publicada ainda)

2. Commit único para Postgres garante atomicidade

3. **Outbox Publisher** (worker polling) lê `outbox_messages` não publicadas e:
   - Publica evento em SQS
   - Marca como `published_at` no Postgres
   - Retry com backoff se falhar

**Benefício**: Se API falhar após commit mas antes de publicar SQS, o worker ainda publica via polling

### 2. Inbox Pattern (SQS → Postgres)

Quando o consumer consome uma mensagem:
1. Cria entrada em `inbox_messages` (consumer_name + message_id = chave única)
2. Se message_id já existe → idempotent: retorna cached result
3. Processa e persiste resultado
4. SQS ack apenas após Postgres commit

**Benefício**: Redeliveries de SQS não duplicam débitos

## System Components

### Domain Layer
- `src/domain/wagering/` - WagerTransaction aggregate root, validações
- `src/domain/wallet/` - Wallet aggregate, ledger entries
- `src/domain/money/` - Value object Money (decimal handling)
- `src/domain/events/` - Domain events (WalletBalanceChanged, etc)

### Application Layer
- `src/application/use-cases/` - Use cases (ProcessWagerTransaction, PublishOutbox, etc)
- `src/application/services/` - Application services (WagerTransactionApplier)
- `src/application/ports/` - Interfaces (UnitOfWork, EventPublisher, Clock, Metrics)
- `src/application/validation.ts` - Validation utilities

### Infrastructure Layer
- `src/infra/database/` - TypeORM setup, repositories, migrations
- `src/infra/messaging/` - SQS consumer, event publisher, message transformations
- `src/infra/http/` - Controllers, exception filters, auth guards
- `src/infra/observability/` - Logger, Prometheus metrics
- `src/infra/jobs/` - PollingWorker (background jobs)

### Modules
- `CoreModule` - Shared domain logic (ProcessWagerTransaction, repositories, clock)
- `AppModule` - API HTTP layer
- `WorkerModule` - Background worker (polling, SQS consumption)

## Transaction Boundaries

### Processing a Wager (API endpoint)

```
HTTP POST /wagering/wagers
  ↓
ProcessWagerTransaction.execute()
  ↓
UnitOfWork.transactional(async (tx) => {
  1. Check wallet exists
  2. Load wallet state (ledger entries)
  3. Validate transaction (balance, rules)
  4. Create WagerTransaction entity (PENDING)
  5. Apply debit to wallet (create ledger entry)
  6. Create OutboxMessage (not published yet)
  7. Check inbox for idempotent replays
})
  ↓
Commit Postgres transaction (atomic)
  ↓
Response 200 OK
```

**Key**: Everything happens in one Postgres transaction. If anything fails, rollback = no state change.

### Publishing Outbox Events (Worker polling)

```
PublishOutbox.execute() (runs every 500ms)
  ↓
Select unpublished messages from outbox_messages
  ↓
For each batch:
  - EventPublisher.publish() → SQS
  - Update outbox_messages.published_at
  - Commit
  ↓
If SQS fails: exponential backoff retry (next polling cycle)
```

### Processing SQS Message (Worker consumer)

```
SQS receives message
  ↓
SqsConsumer
  ↓
Create/check InboxMessage (consumer_name + message_id)
  ↓
If new:
  - ProcessWagerTransaction.execute()
  - Creates another WagerTransaction
  ↓
If duplicate:
  - Skip (idempotent)
  ↓
SQS ack (only after commit)
```

## Concurrency & Consistency

### Multiple Instances Processing Same Queue

The system handles multiple workers consuming the same SQS queue:

1. **SQS visibility timeout** (30s default): Only one worker processes a message at a time
2. **InboxMessage unique constraint** (consumer_name, message_id): Prevents duplicates if visibility timeout expires
3. **WagerTransaction** has (providerId, externalTransactionId, kind) composite key: Idempotent at provider level

### Failure Scenarios Handled

| Scenario | Handling |
|----------|----------|
| Worker dies after commit, before SQS ack | Message redelivered, inbox prevents duplicate |
| Worker dies after publish, before commit | Outbox publishes again (polling) |
| Multiple workers on same message | Inbox unique constraint prevents duplicate debits |
| Provider idempotent retry | WagerTransaction composite key prevents duplicate |
| Wallet not found | Clear error, no ledger corruption |
| Insufficient balance | Transaction marked REJECTED, no debit |

## Database Schema

### wallets
- `id` (PK)
- `balance` (decimal, sum of ledger entries)

### wallet_ledger_entries
- `id` (PK)
- `wallet_id` (FK)
- `direction` (DEBIT/CREDIT)
- `amount`, `currency`
- Immutable (trigger prevents updates)

### wager_transactions
- `id` (PK)
- `provider_id`, `external_transaction_id`, `kind` (unique composite)
- `wallet_id`, `player_id`
- `status` (PENDING/PROCESSED/REJECTED)
- `failure_code` (reason for rejection)
- Indexed by status, wallet_id for queries

### inbox_messages
- `consumer_name`, `message_id` (unique composite, PK)
- Tracks processed SQS messages

### outbox_messages
- `id` (PK)
- `aggregate_type`, `aggregate_id`
- `event_type`, `payload` (JSON)
- `published_at` (NULL = not published)
- Indexed by published_at for polling

## Key Design Decisions

1. **Decimal for money** (not float): Uses Postgres DECIMAL, TypeORM BigDecimal
   - Prevents floating-point rounding errors
   - Exact financial calculations

2. **Outbox + Inbox Pattern**: Instead of distributed transactions
   - No 2PC (two-phase commit)
   - Polling-based consistency
   - Works across service boundaries

3. **Immutable ledger**: Trigger prevents updates to ledger entries
   - Audit trail
   - No accidental modifications
   - Balance = SUM(ledger) always correct

4. **Composite keys for idempotency**:
   - WagerTransaction: (providerId, externalTransactionId, kind)
   - InboxMessage: (consumerName, messageId)
   - Provider controls idempotency; consumer handles redelivery

5. **Status-based workflow**:
   - PENDING → PROCESSED/REJECTED
   - Never goes backward
   - Allows resumption if worker dies mid-processing

## Testing

- **Unit tests** (`src/domain/**/*.spec.ts`): Domain logic, aggregates
- **Integration tests** (`src/infra/**/*.int.spec.ts`): Database, SQS, repositories
- **Concurrency tests** (`test/concurrency/`): Multiple workers, failure scenarios

Run all: `bun run test`

## Observability

- **Logger**: Structured logging (error, warn, info)
- **Prometheus metrics**: Processing latency, transaction counts, failures
- **SQS queue depth**: Monitored in tests to ensure processing keeps up

## Failure Recovery

If a worker crashes:

1. **Incomplete message in SQS**: Visibility timeout expires → message redelivered
2. **Unpublished outbox events**: Worker polling picks them up
3. **Inconsistent state**: Inbox + idempotency prevent corrupting wallet balance

The system is designed to **fail safely**: partial operations are always completed on retry, never left hanging.
