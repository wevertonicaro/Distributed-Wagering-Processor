# MEMÓRIA DO PROJETO: Distributed Wagering Processor (Jungle Gaming)

> Cole este arquivo no início de uma nova conversa (ou deixe no Project) e diga: **"Retome o projeto
> a partir da Etapa 5."** Atualizado em: 01/11/2026 (Etapas 1 a 4 concluídas, todos os testes
> passando)

---

## 1. Contexto

- Desafio técnico da **Jungle Gaming** (iGaming): serviço financeiro distribuído que processa
  transações de aposta de provedores, com entrega at-least-once.
- Operações: `BET → WIN | LOSS | REFUND | ROLLBACK` (+ `OPENING` interno).
- Avaliação (100 pts): correção financeira 20, concorrência 20, idempotência 15, mensageria/falhas
  15, modelagem 10, testes 10, observabilidade 5, documentação 5. Autenticação **não pontua**
  (documentar a decisão e deixar ponto de extensão).
- **Falhas eliminatórias**: `number` para dinheiro, saldo negativo por race, débito/crédito
  duplicado, idempotência só em memória, correto só com 1 instância, evento publicado antes do
  commit, sem ledger auditável, testes que trocam Postgres/SQS por mocks.

### Regras de trabalho combinadas

- Prática antes de teoria, ritmo rápido, código completo e testado a cada etapa, português.
- **Seguir estritamente o enunciado e não gerar código ou arquivos desnecessários.** Só criar um
  arquivo se for exigido pelo enunciado, evitar um erro de correção ou já tiver um segundo
  consumidor. Sem classe de caso de uso para leitura simples, sem porta para métricas, sem abstração
  sem uso.

## 2. Stack e ambiente

| Item                                | Valor                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Runtime / pkg manager / test runner | Bun 1.4.4                                                                         |
| Linguagem                           | TypeScript estrito (TS 6)                                                         |
| Framework                           | NestJS                                                                            |
| ORM                                 | **TypeORM** (só como DataSource/EntityManager + SQL explícito; **sem `@Entity`**) |
| Banco                               | PostgreSQL 16 (Docker)                                                            |
| Mensageria                          | SQS via LocalStack (ainda não configurado)                                        |
| SO do dev                           | Windows + PowerShell                                                              |

### Particularidades já resolvidas

- Bun instalado via `powershell -c "irm bun.sh/install.ps1 | iex"` (reabrir terminal).
- `bun:test` sem tipos: `bun add -d @types/bun` e `"types": ["bun"]` no tsconfig.
- TS 6: `baseUrl` **removido** do tsconfig (imports relativos).
- tsconfig é `module: commonjs` → **não usar `import.meta`**; usar `__dirname`.
- `@types/jest`/`jest` do scaffold do Nest removidos (conflitam com `bun:test`).
- Glob de migrations no Windows precisa de `/`: `.replace(/\\/g, '/')`.
- A ordem das migrations vem do **timestamp no nome da CLASSE** (igual ao do arquivo e ao `name`).
- Bun carrega `.env` e `.env.test` sozinho. `.env.test` aponta para o banco `wagering_test`.
- No Postgres, o TypeORM devolve `[rows, rowCount]` em `UPDATE`; o helper `rowsOf` normaliza.

## 3. Estado atual (checklist)

- [x] **Etapa 1**: setup + `Money` (bigint de centavos)
- [x] **Config**: `src/infra/config/env.ts`, `.env`, `.env.example`, `.env.test`
- [x] **Nest ligado**: `app.module.ts` (TypeOrmModule.forRoot, `synchronize:false`), `main.ts`
      (`enableShutdownHooks`), `Dockerfile`, `.dockerignore`
- [x] **docker-compose.yml**: serviços `postgres` e `api` (sem localstack ainda)
- [x] **Etapa 2: Migrations** (6 arquivos, um por tabela, API do QueryRunner; SQL cru só no
      trigger) + `schema.int.spec.ts` (21 testes)
- [x] **Etapa 3: Domínio** (Wallet, WalletLedgerEntry, WagerTransaction, FailureCode, payload-hash,
      DomainError): **testes unitários passando**
- [x] **Etapa 4: Persistência + casos de uso** (`CreateWallet`, `ProcessWagerTransaction`,
      `WagerTransactionApplier`, repositórios SQL, UnitOfWork, eventos de integração,
      `OutboxMessage`): **`test:unit` e `test:int` passando**, inclusive concorrência (2×80, 50× a
      mesma aposta, hot wallet, wallets distintas)
- [ ] Etapa 5: API HTTP
- [ ] Etapas 6 a 9 (seção 12)

### Limpeza pendente (pequena)

- Apagar `Wallet.canDebit` (código morto, ninguém chama).
- Opcional: `Clock`/`IdGenerator` (`clock.port.ts`) e `validation.ts` são pequenos e foram mantidos;
  `schema.int.spec.ts` pode passar a usar `test-support/test-db.ts`.

## 4. Estrutura de pastas (existente)

```
wagering/
├── .env / .env.example / .env.test
├── docker-compose.yml                     # postgres + api
├── Dockerfile / .dockerignore
├── package.json / tsconfig.json
├── ARCHITECTURE.md / memoria.md
└── src/
    ├── main.ts / app.module.ts
    ├── domain/
    │   ├── domain-error.ts                # DomainError abstrata { code }
    │   ├── money.ts / money.spec.ts
    │   ├── wallet/        wallet.ts, wallet-ledger-entry.ts, wallet.errors.ts, wallet.spec.ts
    │   ├── wagering/      wager-transaction.ts, wager-transaction.errors.ts, failure-code.ts,
    │   │                  payload-hash.ts, wager-transaction.spec.ts
    │   ├── events/        integration-event.ts, wagering-events.ts, wallet-balance-changed.ts
    │   └── messaging/     outbox-message.ts, outbox-message.spec.ts
    ├── application/
    │   ├── errors.ts                      # IdempotencyConflict, WalletNotFound, WalletAlreadyExists, ConcurrentModification
    │   ├── validation.ts                  # assertUuid
    │   ├── ports/         clock.port.ts, repositories.port.ts, unit-of-work.port.ts
    │   ├── services/      wager-transaction-applier.ts
    │   └── use-cases/     create-wallet.ts, process-wager-transaction.ts
    ├── infra/
    │   ├── config/env.ts
    │   └── database/
    │       ├── data-source.ts / migrate.ts / schema.int.spec.ts
    │       ├── typeorm-unit-of-work.ts    # READ COMMITTED
    │       ├── migrations/                # 6 arquivos, timestamps 17934640...
    │       └── repositories/              # sql.ts, pg-wallet, pg-wager-transaction, pg-ledger, pg-outbox,
    │                                      # process-wager-transaction.int.spec.ts
    └── test-support/  test-db.ts, app-factory.ts
```

### Ainda por criar (apenas o que o enunciado exige)

```
src/
├── worker.ts / worker.module.ts           # consumer SQS + outbox publisher + pending-reference
├── domain/messaging/inbox-message.ts      # exigido na seção 6.5 do enunciado
├── application/use-cases/reconcile-wallet.ts
├── infra/
│   ├── database/repositories/             # inbox repo, leitura (wallet, ledger, transação)
│   ├── messaging/    sqs-consumer.ts, sqs-event-publisher.ts, error-classifier.ts
│   ├── http/         controllers (wallets, wagering, health), domain-exception.filter.ts, no-op-auth.guard.ts
│   └── observability/ logger.ts, metrics.ts (prom-client)
├── test/ (integration/, concurrency/, load/ opcional)
└── scripts/init-queues.sh                 # LF, não CRLF
```

## 5. Scripts (package.json)

```json
"migration:run": "bun run src/infra/database/migrate.ts up",
"migration:revert": "bun run src/infra/database/migrate.ts down",
"migration:create": "typeorm migration:create",
"test:unit": "bun test src/domain",
"test:int": "bun test src/infra"
```

O `schema.int.spec.ts` e o teste de fluxo **recusam rodar** se o banco não terminar em `_test`.

## 6. Decisões de arquitetura (já refletidas no ARCHITECTURE.md)

1. **Dinheiro**: `Money` em `bigint` de centavos; string decimal escala 2; `NUMERIC(19,2)` +
   `char(3)`.
2. **TypeORM sem entidades**: SQL explícito + `rehydrate()`; `synchronize:false`.
3. **Concorrência**: lock pessimista por wallet (`SELECT ... FOR UPDATE`); um único lock por
   transação; `updateBalance` ainda confere a versão esperada (defesa em profundidade).
4. **DDL**: API do QueryRunner, uma migration por tabela; SQL cru só no trigger.
5. **Ledger imutável** por trigger `BEFORE UPDATE OR DELETE`.
6. **Reversão única por referência** (índice parcial): uma referência é revertida **uma vez no
   total** (REFUND ou ROLLBACK).
7. **WIN com referência**: opcional e informativa (não resolve nem bloqueia).
8. **Valor zero**: só LOSS aceita.
9. **`observed_balance`** só em PROCESSED; replay de REJECTED devolve apenas o `failureCode`.
10. **`WALLET_NOT_FOUND` não é failureCode**: é erro 404 e **não persiste** (a FK impede). Removido
    do enum `FailureCode`.
11. **Fluxo do `ProcessWagerTransaction`**: valida e monta a transação sem tocar no banco → (na
    transação SQL) replay sem lock → `FOR UPDATE` da wallet → `INSERT ... ON CONFLICT DO NOTHING` →
    se perdeu a corrida, vira replay do vencedor (ou 409 se o conflito foi no
    `externalTransactionId`) → `WagerTransactionApplier` (regra + saldo + ledger + outbox) → COMMIT.
    Rejeição de negócio comita.
12. **`WagerTransactionApplier`** é reutilizado pelo worker de PENDING_REFERENCE (Etapa 7).
    Semântica: até `maxAttempts` (8) esperas; na tentativa seguinte rejeita com
    `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED` se a referência existe mas não está em
    estado terminal). O evento `WagerTransactionPendingReference` sai só na primeira espera.
13. **Outbox**: `OutboxMessage.id = eventId` (chave de deduplicação dos consumidores); backoff
    exponencial em `scheduleRetry(now, {baseMs,maxMs})`.
14. **`CreateWallet`**: wallet + transação OPENING + lançamento CREDIT + 2 eventos
    (`WagerTransactionProcessed`, `WalletBalanceChanged`) na mesma transação SQL.
15. **Assumidos por padrão (sem objeção)**: fila extra `wager-events.fifo` para a outbox; limite de
    **8 tentativas** para PENDING_REFERENCE (backoff base 2s, teto 5min).
16. **Autenticação**: não implementar; `NoOpAuthGuard` + `ProviderIdentityPort` documentados.
17. **Hash de payload**: sha256 do JSON canônico de
    `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money (normalizado), referenceExternalTransactionId (null se ausente)`.

## 7. Schema (6 tabelas, constraints no banco)

| Tabela                  | Garantias principais                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallets`               | `UNIQUE(player_id, currency)`, `CHECK balance>=0`, `CHECK version>=1`                                                                                                                                                                                                                                                                                                             |
| `wager_transactions`    | `UNIQUE(provider_id, idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, checks de kind/status/amount, referência obrigatória em REFUND/ROLLBACK, `failure_code` obrigatório em REJECTED/FAILED, PROCESSED exige `processed_at`+`observed_balance`, OPENING ⇔ `provider_id='INTERNAL'`, índice parcial de reversão única, índice parcial de PENDING_REFERENCE, FKs |
| `wallet_ledger_entries` | `UNIQUE(wallet_id, transaction_id)`, `seq` identity `GENERATED ALWAYS`, `amount>0`, saldos >=0, aritmética `before ± amount = after`, trigger de imutabilidade                                                                                                                                                                                                                    |
| `inbox_messages`        | PK `(consumer_name, message_id)`                                                                                                                                                                                                                                                                                                                                                  |
| `outbox_messages`       | `seq` identity, `payload jsonb`, `attempts>=0`, índice parcial `WHERE published_at IS NULL`, `next_attempt_at`, `last_error`                                                                                                                                                                                                                                                      |

## 8. API do código (resumo)

**Domínio**

- `Money`: `from` (rejeita negativo), `fromStored` (aceita qualquer sinal), `zero`,
  `add/subtract/negate`, comparações, `toJSON/toString`.
- `Wallet.open(...) → { wallet, openingEntry? }`; `debit/credit(m) → WalletLedgerEntry` com
  `m = { entryId, transactionId, amount, at }` (cria o lançamento antes de mutar); `version` sobe só
  quando o saldo muda.
- `WagerTransaction`: `create` (rejeita OPENING e provider `INTERNAL`), `createOpening`,
  `rehydrate`; `markProcessed(refId|undefined, observedBalance, at)`,
  `markPendingReference(nextAttemptAt)`, `reject(code)`, `fail(code)`;
  `validateReference(ref) → FailureCode|undefined`; `ledgerDirectionFor(ref?)`.
- Máquina: `PENDING → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED`;
  `PENDING_REFERENCE → ele mesmo | PROCESSED | REJECTED | FAILED`; três terminais.
- Eventos: `IntegrationEvent<T>` (classe abstrata; `eventType`/`version` no tipo),
  `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
  `WalletBalanceChanged`.

**Aplicação**

- `UnitOfWork.run(work)` entrega `TransactionContext { wallets, transactions, ledger, outbox }`
  ligado à **mesma** transação SQL.
- `ProcessWagerTransaction.execute(cmd) → { transactionId, status, failureCode?, balance?, idempotentReplay }`.
- `CreateWallet.execute({ playerId, initialBalance }) → { id, playerId, balance, version }`.
- Erros: `IdempotencyConflictError` (409), `WalletNotFoundError` (404), `WalletAlreadyExistsError`
  (409), `ConcurrentModificationError` (503/retry).

## 9. Taxonomia de falhas

| failureCode             | Ação do provedor |
| ----------------------- | ---------------- |
| INSUFFICIENT_FUNDS      | GIVE_UP          |
| REVERSAL_WOULD_OVERDRAW | CONTACT_SUPPORT  |
| REFERENCE_NOT_FOUND     | FIX_PAYLOAD      |
| REFERENCE_MISMATCH      | FIX_PAYLOAD      |
| REFERENCE_NOT_PROCESSED | GIVE_UP          |
| INVALID_REFERENCE_KIND  | FIX_PAYLOAD      |
| AMOUNT_MISMATCH         | FIX_PAYLOAD      |
| ALREADY_REVERSED        | GIVE_UP          |
| WALLET_PLAYER_MISMATCH  | FIX_PAYLOAD      |
| CURRENCY_MISMATCH       | FIX_PAYLOAD      |
| INFRA_PERMANENT         | CONTACT_SUPPORT  |

Estados terminais fazem **replay com a mesma key**: "FIX_PAYLOAD" = enviar nova transação com
**nova** key.

## 10. Contrato HTTP (decidido)

| Situação                                                       | HTTP                         |
| -------------------------------------------------------------- | ---------------------------- |
| Payload inválido / header ausente                              | 400                          |
| Wallet/transação inexistente                                   | 404                          |
| Conflito de idempotência / wallet duplicada                    | 409 (campo `code` distingue) |
| Rejeição de negócio                                            | 422 + `failureCode`          |
| Aceito, aguardando referência                                  | 202                          |
| Processado (inclusive replay, `idempotentReplay:true`)         | 200                          |
| Falha transitória (DB/SQS fora, `ConcurrentModificationError`) | 503 + `Retry-After`          |

Endpoints: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger?cursor&limit`,
`GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalId`,
`POST /wagering/transactions` (header `Idempotency-Key` obrigatório),
`POST /wallets/:id/reconciliation`, `GET /health/live`, `GET /health/ready`.

## 11. Próximo passo: Etapa 5, API HTTP (plano enxuto)

Só o que o enunciado exige:

1. **Wiring Nest** (`app.module.ts`): providers para `TypeOrmUnitOfWork` (a partir do `DataSource`
   injetado), `WagerTransactionApplier` (com `env.pendingReference`), `CreateWallet`,
   `ProcessWagerTransaction`.
2. **`DomainExceptionFilter`** (único): mapeia por `error.code`:
   `INVALID_MONEY`/`INVALID_WAGER_TRANSACTION`/`CURRENCY_MISMATCH` → 400; `WALLET_NOT_FOUND` → 404;
   `IDEMPOTENCY_CONFLICT`/`WALLET_ALREADY_EXISTS` → 409; `CONCURRENT_MODIFICATION` e erros de
   conexão do Postgres → 503 + `Retry-After`; resto → 500. Corpo de erro sempre `{ code, message }`.
3. **Controllers**: `POST /wallets` (201), `POST /wagering/transactions` (header `Idempotency-Key`
   obrigatório → 400 se ausente; resultado: PROCESSED 200, PENDING_REFERENCE 202, REJECTED 422 com
   `failureCode`), consultas de wallet/transação.
4. **Leitura**: sem classes de caso de uso; um repositório de leitura simples chamado direto pelos
   controllers (`GET wallet`, `GET transação por id`, `GET por provider+external`, ledger).
5. **Ledger com cursor opaco**: ordenado por `seq`, cursor = base64url do último `seq`, `limit`
   padrão 50 (máx. 200), resposta `{ items, nextCursor }`.
6. **Reconciliação**: `ReconcileWallet` (soma créditos − débitos do ledger vs `wallets.balance`);
   divergência é logada, contada em métrica e sinalizada (`consistent:false`), **nunca corrigida**.
   `metrics.ts` (prom-client) nasce aqui, porque este é o primeiro consumidor.
7. **Health**: `/health/live` (processo) e `/health/ready` (Postgres agora; SQS entra na Etapa 6).
   Sem autenticação.
8. **`NoOpAuthGuard`** + `ProviderIdentityPort` apenas como ponto de extensão documentado.
9. **Testes**: e2e HTTP contra o Postgres real (status codes de cada situação, replay, 409, 404, 400
   sem header, ledger paginado, reconciliação consistente e divergente).

## 12. Roadmap restante

5. API HTTP (acima)
6. Consumer SQS: `InboxMessage` (domínio) + repo de inbox, consumer com ack pós-commit,
   classificação business/transient/permanent, DLQ (`maxReceiveCount=5`), SIGTERM; subir
   LocalStack + `scripts/init-queues.sh` (LF) no compose; `/health/ready` passa a checar SQS
7. Outbox publisher (`FOR UPDATE SKIP LOCKED`, backoff, múltiplos publishers) + worker de
   `PENDING_REFERENCE` reutilizando o `WagerTransactionApplier`
8. Testes de concorrência **com múltiplos processos** (≥3 instâncias), worker morto entre commit e
   ack, 2 publishers, reversão antes da referência, reinício. Invariante:
   `wallet.balance == saldo reconstruído pelo ledger`
9. Logs JSON (`correlationId, messageId, transactionId, walletId, providerId`), métricas restantes
   (transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência),
   README.md, ARCHITECTURE.md final; opcional: `bun run test:load`

Eventos (outbox → `wager-events.fifo`): `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged` (só se o saldo muda), `WagerTransactionPendingReference`. `data` carrega
`MoneyProps` (string).

### Decisão ainda aberta

- Trigger `BEFORE TRUNCATE` no ledger (proposto, não aplicado; se aplicar, os testes não podem usar
  `TRUNCATE`).

## 13. Comandos úteis

```powershell
docker compose up -d postgres
docker compose exec postgres psql -U wagering -c "CREATE DATABASE wagering_test"   # uma vez
bun run migration:run
bun run migration:revert
bun run test:unit
bun run test:int
docker compose up --build api
docker compose exec postgres psql -U wagering -c "select id, name from migrations order by id"
# reset do banco de DEV (só local):
docker compose exec postgres psql -U wagering -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

## 14. Troubleshooting já visto

| Sintoma                                      | Causa                                       | Solução                                                          |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `bun` não reconhecido                        | Bun não instalado / PATH                    | instalar e reabrir terminal                                      |
| `Cannot find module 'bun:test'`              | faltam tipos                                | `bun add -d @types/bun` + `"types":["bun"]`                      |
| `baseUrl is deprecated`                      | TS 6                                        | remover `baseUrl`                                                |
| `import.meta` não permitido                  | `module: commonjs`                          | usar `__dirname`                                                 |
| Trigger migration: `relation does not exist` | timestamp da **classe** fora de ordem       | alinhar arquivo = classe = `name`; trigger com o maior timestamp |
| `non-DEFAULT value into column "seq"`        | comportamento correto do `GENERATED ALWAYS` | assert com `/non-DEFAULT value/`                                 |
| `UPDATE` não devolve linhas                  | TypeORM devolve `[rows, count]`             | usar `rowsOf`                                                    |
