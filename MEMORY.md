# Memory for Future Sessions

## Project Context

**Wagering** is a distributed betting transaction system that guarantees idempotency and consistency across multiple instances despite failures.

**User**: Weverton Icaro (criartipersonalizados1@gmail.com)
**Tech Stack**: Bun, NestJS, TypeORM, PostgreSQL, AWS SQS (LocalStack for dev)
**Key Patterns**: Transactional Outbox, Inbox for idempotency
**Status**: Core functionality complete, concurrency tests passing

## Recent Work (Session 2026-11-02)

### Bug Fixed: WORKER_PORT validation error in concurrency tests

**Problem:**
- Concurrency tests were failing with `Invalid env var WORKER_PORT: expected integer >= 1, got "0"`
- Process exit code was 1 instead of expected 137 (SIGKILL)

**Root Cause:**
- Test functions `crash-after-commit-worker.ts` and `crash-after-publish.ts` were spawned without a port
- Default port parameter was 0, which failed validation in `src/infra/config/env.ts:29`
- Validation requires `WORKER_PORT >= 1`

**Solution:**
- Generated random valid port (41000-49000) before spawning each crash worker
- Tests now pass all 4 concurrency scenarios successfully

**Files Changed:**
- `test/concurrency/multi-process.int.spec.ts` - Lines 242 and 274 (added port generation)

### Documentation Created

**Files Added:**
- `ARCHITECTURE.md` - System design, patterns, transaction flow, database schema
- `README.md` - Quick start, API endpoints, running tests, troubleshooting
- `MEMORY.md` - This file

## Key Technical Insights

### Idempotency Strategy

1. **Provider Level**: `WagerTransaction` has unique composite key (providerId, externalTransactionId, kind)
   - Prevents duplicate debits if provider retries with same ID

2. **Consumer Level**: `InboxMessage` has unique composite key (consumer_name, message_id)
   - Prevents duplicate processing if SQS redelivers after visibility timeout

3. **Result**: Can safely replay any operation without side effects

### Transaction Boundaries

- **Single Postgres Transaction**: All state changes in one TX → atomic commit
  - Wallet debit + transaction creation + outbox message = all or nothing
  - No partial states possible

- **Polling-Based Consistency**: Outbox messages are eventually published
  - Worker polls unpublished messages every 500ms
  - Exponential backoff on SQS failures
  - Guaranteed eventual delivery

### Failure Handling

| Failure | Handling |
|---------|----------|
| Worker dies mid-processing | Message visible again in SQS after timeout → redelivered |
| Worker dies after commit, before SQS ack | Inbox pattern prevents duplicate on retry |
| Outbox message not published | Polling worker retries with backoff |
| Multiple workers on same queue | SQS visibility timeout + inbox unique constraint |
| Wallet not found | Clear error, no ledger entry created |
| Insufficient balance | Transaction marked REJECTED, no debit |

### Database Design

- **Immutable Ledger**: Trigger prevents updates to `wallet_ledger_entries`
  - Balance always = SUM(ledger)
  - Audit trail
  
- **Status Workflow**: `WagerTransaction` never goes backward
  - PENDING → PROCESSED or REJECTED
  - Allows resumption if worker dies

- **Composite Keys**: Enable idempotency at multiple levels
  - Provider can retry safely
  - Consumer redelivery is safe

## Testing Strategy

### Unit Tests (`bun run test:unit`)
- Domain logic: Money, Wallet, WagerTransaction aggregates
- Validation rules, business logic
- ~200ms execution

### Integration Tests (`bun run test:int`)
- Database operations, repositories
- SQS client mocking, messaging
- ~5-10s execution

### Concurrency Tests (`bun run test:concurrency`)
- **Critical**: Real multi-process scenarios
- Hot wallet (same wallet, multiple workers)
- Worker crashes mid-transaction
- Multiple publish failures
- ~30s execution, real Postgres + SQS

**Recent Fix**: Port validation was preventing crash worker tests from starting

## Important Notes for Future Work

### Concurrency Tests Parameters

```typescript
// In test/concurrency/multi-process.int.spec.ts
const port = 41_000 + Math.floor(Math.random() * 8_000); // Must be provided
spawn('test/support/crash-after-commit-worker.ts', port); // port is mandatory
```

- Crash worker scripts don't start HTTP server but still need valid WORKER_PORT
- Port range 41000-49000 used to avoid conflicts

### Environment Variables

Critical for local dev:
- `DATABASE_URL` - Must match docker-compose Postgres
- `AWS_ENDPOINT_URL` - LocalStack endpoint (http://localhost:4566 for docker-compose)
- `WORKER_PORT` - Must be integer >= 1
- `CONSUMER_CONCURRENCY` - Tune for performance
- `SQS_VISIBILITY_TIMEOUT_SECONDS` - Controls redelivery timeout

### Health Checks

- API: `GET http://localhost:3000/health/live`
- Worker: `GET http://localhost:3001/health/live`
- Tests use these in `waitFor()` loops to ensure service readiness

### Message Flow Timing

```
Create wager (API)     → OutboxMessage created (unpublished)
Polling worker        → Sees unpublished, publishes to SQS
SQS message visible   → Consumer picks up
Consumer processes    → Creates inbox entry
Idempotent check      → (consumer_name, message_id) prevents duplicate
```

Total: Usually < 1 second, but can be slower on busy systems.

## Known Limitations & Future Improvements

### Current Limitations

1. **No distributed tracing**: Hard to follow a transaction across API → Worker → SQS
   - Could add correlation IDs, trace context headers

2. **Basic error classification**: Provider errors vs transient failures
   - Could use retry strategy per error type

3. **No circuit breaker**: If SQS is down, worker keeps retrying
   - Could add exponential backoff upper limit or circuit breaker

### Potential Improvements

- [ ] OpenTelemetry integration for distributed tracing
- [ ] Circuit breaker for external services
- [ ] Dead letter handling for permanently failed messages
- [ ] Webhook for provider notification on failure
- [ ] Bulk transaction processing endpoint
- [ ] Provider-specific failure handling strategy
- [ ] Query API for transaction history

## Commands Quick Reference

```bash
# Setup
bun install
docker-compose up -d
bun run migration:run

# Development
bun run start:api      # Terminal 1
bun run start:worker   # Terminal 2

# Testing
bun run test           # All tests
bun run test:concurrency  # Important for verifying concurrent scenarios

# Quality
bun run lint
bun run format

# Database
bun run migration:run
bun run migration:revert
```

## Code Conventions

- **DDD**: Domain entities in `src/domain`, use-cases in `src/application`, infra in `src/infra`
- **Ports & Adapters**: Interfaces in `src/application/ports`, implementations in infra
- **Decimal for money**: Always use TypeORM's `decimal` type, never float
- **Immutable domain**: Value objects are readonly, aggregates validate state
- **Testing**: One assert per test when possible, clear test names

## Questions to Clarify Before Next Work

- Should wallet balance support multiple currencies? (Currently assumes BRL)
- Are there webhook callbacks needed when wagers fail?
- What's acceptable latency for outbox polling? (Currently 500ms)
- Should there be a provider dashboard or just raw data export?
