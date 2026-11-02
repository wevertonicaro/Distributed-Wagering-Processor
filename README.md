# Wagering

A distributed system for processing betting transactions with guaranteed idempotency and consistency despite failures.

**Key Features:**
- ✅ Idempotent transaction processing
- ✅ No duplicate debits on redelivery
- ✅ Handles worker crashes mid-transaction
- ✅ Multi-instance concurrent processing
- ✅ Transactional outbox pattern for SQS publishing
- ✅ Inbox pattern for idempotent message consumption

## Stack

- **Runtime**: Bun 1.4+ (TypeScript/JavaScript)
- **API Framework**: NestJS 11
- **Database**: PostgreSQL 16
- **Message Queue**: AWS SQS (LocalStack for local dev)
- **ORM**: TypeORM
- **Monitoring**: Prometheus

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.4+
- [Docker](https://docker.com) + Docker Compose
- PostgreSQL 16 (or use docker-compose)

### Setup

1. **Clone & install**
   ```bash
   bun install
   ```

2. **Start services** (Postgres + LocalStack)
   ```bash
   docker-compose up -d
   ```

3. **Run migrations**
   ```bash
   bun run migration:run
   ```

4. **Start API and Worker in separate terminals**
   ```bash
   # Terminal 1: API
   bun run start:api

   # Terminal 2: Worker
   bun run start:worker
   ```

API listens on `http://localhost:3000`
Worker listens on `http://localhost:3001` (health check endpoint)

## Development

### Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Key variables:
- `DATABASE_URL` - PostgreSQL connection
- `AWS_ENDPOINT_URL` - LocalStack endpoint (local only)
- `SQS_WAGER_QUEUE_URL` - Main queue
- `WORKER_PORT` - Port for worker HTTP server
- `CONSUMER_CONCURRENCY` - Number of concurrent SQS consumers (default: 5)

### Scripts

```bash
# Build
bun run build

# Code quality
bun run lint
bun run format

# Testing
bun run test              # All tests
bun run test:unit         # Domain logic only
bun run test:int          # Integration tests
bun run test:concurrency  # Multi-instance failure scenarios

# Database
bun run migration:run     # Apply all migrations
bun run migration:revert  # Revert last migration

# Running
bun run start:api         # Start API (port 3000)
bun run start:worker      # Start Worker (port 3001)
```

## API Endpoints

### Create Wallet
```bash
POST /wallets
Content-Type: application/json

{
  "playerId": "uuid-here",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}

Response:
{
  "id": "wallet-uuid",
  "balance": { "amount": "100.00", "currency": "BRL" }
}
```

### Process Wager
```bash
POST /wagering/wagers
Content-Type: application/json

{
  "providerId": "provider-a",
  "externalTransactionId": "ext-id-123",
  "idempotencyKey": "provider-a:ext-id-123",
  "playerId": "player-uuid",
  "walletId": "wallet-uuid",
  "roundId": "round-1",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}

Response:
{
  "transactionId": "wager-uuid",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" }
}
```

### Health Check
```bash
GET /health/live
# Returns 200 if service is ready
```

## Testing

### Unit Tests

Domain logic validation:
```bash
bun run test:unit
```

Tests: `src/domain/**/*.spec.ts`

### Integration Tests

Database, SQS, repositories:
```bash
bun run test:int
```

Tests: `src/infra/**/*.int.spec.ts`

### Concurrency Tests

**Critical**: Tests the system under failure scenarios.

```bash
bun run test:concurrency
```

Tests: `test/concurrency/multi-process.int.spec.ts`

**Scenarios tested:**
1. Multiple workers on same queue, same wallet (hot wallet) → No duplicate debits
2. Worker killed mid-processing, restarted → Consistency maintained
3. Worker dies after commit, before SQS ack → Redelivery doesn't duplicate
4. Worker dies while publishing events → Other workers take over

**Time**: ~30 seconds (uses real Postgres + SQS)

## How It Works

### Wager Processing Flow

```
1. API receives POST /wagering/wagers
   ↓
2. ProcessWagerTransaction validates:
   - Wallet exists
   - Balance sufficient
   - Transaction unique (provider's idempotency key)
   ↓
3. All in single Postgres transaction:
   - Create WagerTransaction (PENDING)
   - Debit wallet (ledger entry)
   - Insert OutboxMessage
   ↓
4. Commit or rollback atomically
   ↓
5. Response sent to caller
```

### Event Publishing Flow

```
1. Worker PollingWorker checks outbox_messages every 500ms
   ↓
2. For each unpublished message:
   - Publish to SQS
   - Update outbox_messages.published_at
   ↓
3. If SQS fails:
   - Exponential backoff
   - Retry next cycle
```

### Message Consumption Flow

```
1. SQS Consumer polls SQS
   ↓
2. For each message:
   - Check InboxMessage (consumer_name + message_id)
   ↓
3. If new:
   - Process (might create another WagerTransaction)
   ↓
4. If duplicate:
   - Skip (idempotent)
   ↓
5. Ack to SQS (only on success)
```

## Data Model

### Wallets
- Store player balance
- Immutable ledger entries prevent corruption
- Balance = SUM(ledger_entries)

### Wager Transactions
- Status: PENDING, PROCESSED, REJECTED
- Idempotent via (providerId, externalTransactionId, kind)
- Tracks failure reason if rejected

### Ledger Entries
- Immutable (database trigger)
- Direction: DEBIT or CREDIT
- Audit trail of all balance changes

### Outbox Messages
- Events waiting to be published to SQS
- Polling retry if initial publish fails
- Published_at timestamp tracks delivery

### Inbox Messages
- SQS message IDs already processed
- Prevents duplicate processing on redelivery
- (consumer_name, message_id) = unique key

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design patterns.

## Monitoring

### Prometheus Metrics

Worker publishes metrics:

```
# Processing latency
wager_processing_duration_seconds_bucket
wager_processing_duration_seconds_sum
wager_processing_duration_seconds_count

# Transaction outcomes
wager_transactions_total{status="PROCESSED"}
wager_transactions_total{status="REJECTED"}

# Queue depth
sqs_queue_depth
```

Access Prometheus:
```bash
curl http://localhost:3001/metrics
```

### Logs

Structured logging (JSON):
```
{"level":"info","message":"wager processed","transactionId":"...","duration":"0.234s"}
{"level":"error","message":"insufficient balance","walletId":"..."}
```

Set `LOG_LEVEL=debug` for verbose output.

## Troubleshooting

### Worker not picking up messages
1. Check LocalStack is running: `docker-compose ps`
2. Check queue URL in env vars matches LocalStack
3. Check worker logs: `bun run start:worker 2>&1 | grep -i error`

### Tests fail on Windows
- Use WSL2 or run on Linux
- Ensure Docker daemon is running
- Check database is healthy: `docker-compose ps`

### Database connection refused
1. Ensure Postgres is running: `docker-compose up postgres`
2. Check `DATABASE_URL` matches docker-compose config
3. Wait for healthcheck: `docker-compose up --wait`

### Port already in use
- API (3000): Change `PORT` env var
- Worker (3001): Change `WORKER_PORT` env var
- Postgres (5432): Change in docker-compose.yaml

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for:
- System design (Outbox + Inbox patterns)
- Concurrency handling
- Failure scenarios
- Transaction boundaries
- Database schema

## Contributing

1. Run tests before pushing: `bun run test`
2. Format code: `bun run format`
3. Follow NestJS patterns (modules, DI, ports/adapters)
4. Add tests for new features
5. Update this README if behavior changes

## License

UNLICENSED
