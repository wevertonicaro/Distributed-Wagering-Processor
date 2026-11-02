# ARCHITECTURE

Distributed Wagering Processor: serviço financeiro que processa transações de aposta vindas de
múltiplos provedores de jogos, com entrega at-least-once.

**Legenda de status**: ✅ implementado e testado · 🔜 decidido, será implementado

Este documento é atualizado a cada etapa. Decisões ainda abertas estão na seção 21.

---

## 1. Visão geral

Dois processos, mesmo código-base:

- **api** (`src/main.ts`): HTTP.
- **worker** (`src/worker.ts`) 🔜: consumer SQS, publisher da outbox e reprocessador de
  `PENDING_REFERENCE`.

Ambos escalam horizontalmente e **não compartilham estado em memória**. O **PostgreSQL é a única
fonte de verdade** para idempotência, saldo e ordenação de efeitos: nenhuma garantia depende de
cache em processo nem de ordenação do broker.

Invariantes globais: o sistema não duplica créditos, não duplica débitos, não perde eventos
confirmados e não permite saldo negativo.

## 2. Camadas

Arquitetura hexagonal. A dependência aponta sempre para dentro.

| Camada         | Pasta             | Regra                                                                                                             |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Domínio        | `src/domain`      | Puro: sem Nest, sem TypeORM. Estado encapsulado (construtor privado + factories `create` / `from` / `rehydrate`). |
| Aplicação      | `src/application` | Casos de uso, portas (interfaces) e o aplicador de regras. Conhece o domínio, não conhece infraestrutura.         |
| Infraestrutura | `src/infra`       | Implementa as portas: Postgres/TypeORM, SQS, HTTP, observabilidade, configuração.                                 |

O mesmo caso de uso (`ProcessWagerTransaction`) atende a entrada HTTP e a entrada SQS. Só existem as
abstrações com uso real: portas de repositório e de unidade de trabalho (necessárias para a
transação única), sem camadas de indireção extras.

## 3. Stack

| Item                                    | Escolha                            |
| --------------------------------------- | ---------------------------------- |
| Runtime / package manager / test runner | Bun 1.x                            |
| Linguagem                               | TypeScript em modo estrito         |
| Framework                               | NestJS                             |
| Banco                                   | PostgreSQL 16                      |
| ORM                                     | TypeORM (ver seção 5)              |
| Mensageria                              | AWS SQS via LocalStack 🔜          |
| Orquestração local                      | Docker Compose                     |
| Migrations                              | TypeORM, versionadas e reversíveis |

Observações de ambiente: o projeto roda TypeScript direto no Bun (sem etapa de build). O `tsconfig`
usa `module: commonjs`, então o código usa `__dirname` (não `import.meta`). `baseUrl` foi removido
(deprecated no TypeScript 6); os imports são relativos.

## 4. Dinheiro ✅

`Money` guarda **centavos em `bigint`** mais a moeda ISO-4217.

- Entrada e saída são **strings decimais** de escala fixa 2 (`"25.00"`).
- Entradas inválidas são rejeitadas: vazio, `NaN`, `Infinity`, notação científica, mais de 2 casas
  decimais, valores negativos nos contratos de entrada, moeda fora de `^[A-Z]{3}$`.
- `Money` é imutável: toda operação devolve nova instância.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- `Money.from` rejeita negativos (contrato de entrada). `Money.fromStored` aceita qualquer sinal
  (reidratação).
- No banco: `NUMERIC(19,2)` + `char(3)`. O driver `pg` devolve `NUMERIC` como string, então **nenhum
  `number` toca em valor monetário** em nenhum ponto do caminho (os repositórios gravam
  `money.toString()` e reidratam com `fromStored`).
- O modelo é multi-moeda; os testes cobrem o conflito de moeda.

## 5. ORM: TypeORM ✅

Usado como `DataSource` e `EntityManager` transacional. **Não há `@Entity` no domínio**: os
repositórios executam SQL explícito e reidratam o domínio via `rehydrate()`.

**Justificativa**: a correção do sistema depende de `SELECT ... FOR UPDATE`,
`FOR UPDATE SKIP LOCKED`, `INSERT ... ON CONFLICT DO NOTHING` e índices parciais, que o query
builder expressa mal. Com SQL explícito, o caminho crítico é visível, revisável e testável.

**Trade-off**: abrimos mão do Unit of Work e do Identity Map do ORM e do mapeamento automático de
entidades. Em troca, o domínio não depende de decorators nem de tipos do ORM (requisito do
enunciado) e o `Money` não passa por nenhum transformer. Um detalhe do driver: `UPDATE` devolve
`[rows, rowCount]` no Postgres, normalizado por um helper (`rowsOf`).

**Estratégia transacional**: `TypeOrmUnitOfWork` abre uma transação `READ COMMITTED` e entrega aos
casos de uso os quatro repositórios (wallets, transações, ledger, outbox) ligados à **mesma**
transação SQL. Isolamento `READ COMMITTED` basta porque a serialização é feita por lock explícito de
linha e por índices únicos, não por isolamento serializable (que exigiria retry de falhas de
serialização).

`synchronize` fica sempre `false`: o schema vem exclusivamente das migrations.

## 6. Configuração ✅

Variáveis de ambiente (12-factor), lidas e validadas **no boot** por `src/infra/config/env.ts`.
Valor inválido derruba o processo imediatamente, em vez de falhar no meio de uma transação.

- `.env.example` é versionado e documenta todas as variáveis; `.env` fica fora do git.
- O Bun carrega `.env` e `.env.test` automaticamente.
- Dentro do Docker Compose, os hosts mudam (`localhost` vira `postgres` e `localstack`): o serviço
  sobrescreve apenas essas variáveis em `environment`.

| Grupo             | Variáveis                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App               | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`                                                                                                                                          |
| PostgreSQL        | `DATABASE_URL`, `DB_POOL_MAX`                                                                                                                                                                   |
| AWS / LocalStack  | `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                  |
| SQS               | `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`, `SQS_EVENTS_QUEUE_URL`, `SQS_WAIT_TIME_SECONDS`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_MAX_RECEIVE_COUNT`, `CONSUMER_NAME`, `CONSUMER_CONCURRENCY` |
| Outbox            | `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BACKOFF_BASE_MS`, `OUTBOX_BACKOFF_MAX_MS`                                                                                               |
| PENDING_REFERENCE | `PENDING_REF_MAX_ATTEMPTS`, `PENDING_REF_BACKOFF_BASE_MS`, `PENDING_REF_BACKOFF_MAX_MS`, `PENDING_REF_POLL_INTERVAL_MS`                                                                         |
| Auth              | `AUTH_ENABLED`                                                                                                                                                                                  |

Testes de integração usam `.env.test`, que aponta para o banco `wagering_test`; os testes **recusam
rodar** em qualquer banco cujo nome não termine em `_test`.

## 7. Migrations e schema ✅

### 7.1 Organização das migrations

**Uma migration por tabela**, para histórico claro, revert granular e diffs pequenos em code review.
A ordem de execução é definida pelo **timestamp no nome da classe** (que deve coincidir com o do
arquivo e com a propriedade `name`).

| Ordem | Migration                   | Depende de                  |
| ----- | --------------------------- | --------------------------- |
| 1     | `CreateWallets`             |                             |
| 2     | `CreateWagerTransactions`   | wallets                     |
| 3     | `CreateWalletLedgerEntries` | wallets, wager_transactions |
| 4     | `CreateInboxMessages`       |                             |
| 5     | `CreateOutboxMessages`      |                             |
| 6     | `LedgerImmutabilityTrigger` | wallet_ledger_entries       |

O DDL é escrito com a **API do `QueryRunner`** (`Table`, `TableCheck`, `TableUnique`, `TableIndex`,
`TableForeignKey`). **SQL cru é usado apenas no trigger**, porque o TypeORM não tem API para
triggers e funções. As migrations são carregadas por glob (`migrations/*.{ts,js}`, normalizado para
`/` por causa do Windows), então uma migration nova não exige registro manual. Todas têm `down` e
foram desfeitas e reaplicadas por teste automatizado.

Usa-se `migration:create` (SQL escrito à mão), nunca `migration:generate`, porque não há entidades
para comparar.

### 7.2 Garantias aplicadas no banco

As garantias de unicidade, imutabilidade e não-negatividade vivem **no schema**, não apenas no
código.

| Garantia                                | Mecanismo                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Uma wallet por (player, moeda)          | `UNIQUE (player_id, currency)`                                                                              |
| Saldo nunca negativo                    | `CHECK (balance >= 0)`                                                                                      |
| Idempotência persistente                | `UNIQUE (provider_id, idempotency_key)`                                                                     |
| Operação do provedor única              | `UNIQUE (provider_id, external_transaction_id)`                                                             |
| Reversão única por referência           | índice único parcial em `reference_transaction_id` (`status='PROCESSED'` e `kind IN ('REFUND','ROLLBACK')`) |
| REFUND/ROLLBACK exigem referência       | `CHECK`                                                                                                     |
| Rejeição auditável                      | `CHECK`: REJECTED/FAILED exigem `failure_code`                                                              |
| PROCESSED completo                      | `CHECK`: exige `processed_at` e `observed_balance`                                                          |
| OPENING só interno                      | `CHECK ((kind='OPENING') = (provider_id='INTERNAL'))`                                                       |
| 1 lançamento por (wallet, transação)    | `UNIQUE (wallet_id, transaction_id)`                                                                        |
| Aritmética do ledger                    | `CHECK`: `balance_before ± amount = balance_after`                                                          |
| Lançamento com valor positivo           | `CHECK (amount > 0)`                                                                                        |
| Ledger imutável                         | trigger `BEFORE UPDATE OR DELETE` lança exceção                                                             |
| Ordenação estável do ledger e da outbox | coluna `seq` `GENERATED ALWAYS AS IDENTITY`                                                                 |
| Dedup de inbox                          | PK `(consumer_name, message_id)`                                                                            |

### 7.3 Tabelas

- **`wallets`**: `id`, `player_id`, `currency`, `balance`, `version`, `created_at`, `updated_at`.
- **`wager_transactions`**: dados da operação, `payload_hash`, `status`, `failure_code`,
  `observed_balance`, `reference_transaction_id` (FK interna), `reference_external_transaction_id`,
  `reference_attempts`, `next_reference_attempt_at`, `processed_at`.
- **`wallet_ledger_entries`**: `seq`, `direction`, `amount`, `balance_before`, `balance_after`,
  ligada à transação.
- **`inbox_messages`**: `consumer_name`, `message_id`, `payload_hash`, `received_at`,
  `processed_at`.
- **`outbox_messages`**: `seq`, `aggregate_id`, `event_type`, `payload jsonb`, `occurred_at`,
  `attempts`, `next_attempt_at`, `published_at`, `last_error`. Índice parcial
  `WHERE published_at IS NULL` para a varredura do publisher.

### 7.4 Teste de schema

`schema.int.spec.ts` roda contra um Postgres real e prova cada constraint (21 testes): cada garantia
da tabela acima, mais a reversibilidade das 6 migrations.

### 7.5 Limitações

- O trigger de imutabilidade cobre `UPDATE` e `DELETE`. `TRUNCATE` não dispara trigger de linha; a
  mitigação possível é um trigger `BEFORE TRUNCATE ... FOR EACH STATEMENT` (ver seção 21) e `REVOKE`
  por role em produção.
- Quem é dono da tabela (ou superusuário) pode remover o trigger. Em produção, a aplicação deve
  conectar com um role sem privilégio de DDL.

## 8. Modelo de domínio ✅

Todo agregado segue a regra de modelagem: construtor privado, factories estáticas e reidratação sem
revalidar transições. Erros de domínio estendem `DomainError`, que carrega um `code` estável; isso
permite um único filtro HTTP tratar qualquer erro de forma uniforme.

### 8.1 Wallet (agregado raiz)

- `Wallet.open(...)` devolve `{ wallet, openingEntry? }`. Com saldo inicial maior que zero, devolve
  também o **lançamento CREDIT de abertura** (saldo anterior zero), então a invariante "toda
  alteração de saldo tem lançamento" vale desde o primeiro instante. `version` começa em 1.
- `debit` e `credit` recebem um movimento (`entryId`, `transactionId`, `amount`, `at`) e devolvem o
  `WalletLedgerEntry` correspondente.
- O lançamento é criado **antes** de mutar o estado: se algo falhar, a wallet permanece intacta.
- `version` incrementa **somente quando o saldo muda**.
- Valor deve ser positivo; moeda deve ser a da wallet; débito acima do saldo lança
  `InsufficientFundsError`.

### 8.2 WalletLedgerEntry (imutável)

Sem campos mutáveis e sem métodos de transição; o objeto é **congelado** (`Object.freeze`), então a
imutabilidade é estrutural. `create` valida a aritmética (`balanceBefore ± money === balanceAfter`),
valor positivo e saldos não negativos. `rehydrate` não revalida; `isBalanced()` permite detectar
inconsistência.

### 8.3 WagerTransaction

Nasce `PENDING`. `create` rejeita `OPENING` e o provider reservado `INTERNAL`; o crédito de abertura
usa `createOpening`, determinístico por wallet (`opening:{walletId}`).

**Máquina de estados** (tabela `TRANSITIONS` no código):

```
PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE  -> PENDING_REFERENCE (retry) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED : terminais
```

Transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação, não
caminho de negócio). `PENDING_REFERENCE` só é permitido para REFUND e ROLLBACK e conta tentativas.

**Regras de valor e referência**:

- Só `LOSS` aceita valor zero. BET, WIN, REFUND, ROLLBACK e OPENING exigem valor maior que zero.
- REFUND e ROLLBACK exigem `referenceExternalTransactionId`. BET e OPENING não podem carregar
  referência.
- **Interpretação adicional**: em `WIN`, a referência é **opcional e informativa**: é armazenada,
  mas não é resolvida nem bloqueia o processamento. Só REFUND e ROLLBACK usam referência de fato.
- REFUND referencia apenas BET. ROLLBACK referencia BET, WIN ou REFUND.
- `validateReference` confere provider, player, wallet, rodada e moeda (`REFERENCE_MISMATCH`), tipo
  permitido (`INVALID_REFERENCE_KIND`), referência já processada (`REFERENCE_NOT_PROCESSED`) e valor
  igual (`AMOUNT_MISMATCH`). `ALREADY_REVERSED` depende de consulta ao banco: é checado pelo
  aplicador e garantido pelo índice único parcial.
- `ledgerDirectionFor`: BET débito; WIN, REFUND e OPENING crédito; LOSS não tem efeito; ROLLBACK
  **inverte** a direção da transação referenciada.
- `markProcessed` recebe `observedBalance` (saldo logo após aplicar), que o banco exige e que é o
  que o replay devolve.

## 9. Concorrência ✅

Unidade de concorrência: `walletId`. Estratégia: **lock pessimista por wallet**
(`SELECT ... FOR UPDATE` na linha da wallet) dentro da transação financeira.

**Por quê**: com N instâncias, o lock de linha serializa apenas a mesma wallet; wallets distintas
processam em paralelo e não existe lock global. Não precisa de laço de retry como o otimista. Cada
transação toma **um único lock de wallet**, então não há deadlock por ordem de aquisição. O
`CHECK (balance >= 0)` é a rede de segurança final, mesmo que o código erre.

**Defesa em profundidade**: `updateBalance` só atualiza se a `version` no banco for a esperada. Com
o lock isso nunca deveria falhar; se falhar (bug ou lock ausente), lança
`ConcurrentModificationError` (tratado como falha transitória) em vez de sobrescrever
silenciosamente.

**Trade-off**: hot wallets são serializadas. Mitigação: transação curta e sem I/O externo dentro do
lock.

**Comprovação** (suíte de integração com Postgres real, várias conexões do pool disputando ao mesmo
tempo):

- saldo 100.00 e duas apostas de 80.00 simultâneas: exatamente uma PROCESSED, a outra REJECTED
  (`INSUFFICIENT_FUNDS`), saldo final 20.00, um único débito no ledger;
- a mesma aposta enviada 50 vezes em paralelo: um único débito, todas as respostas com o mesmo
  `transactionId`;
- hot wallet: 30 apostas de 10.00 sobre saldo 100.00: exatamente 10 aceitas, 20 rejeitadas, saldo
  0.00;
- 20 wallets distintas em paralelo: todas processadas, cada uma consistente.

A invariante `wallet.balance == saldo reconstruído pelo ledger` (e a cadeia contínua de
`balance_before`/`balance_after`) é verificada ao fim de cada cenário.

**Ainda pendente** 🔜: repetir os cenários com **três ou mais processos** da aplicação (hoje as
conexões concorrentes vêm de um único processo), worker morto entre commit e ack, e reinício do
serviço.

## 10. Fluxo de `ProcessWagerTransaction` ✅

Antes de abrir a transação, o comando é validado e a transação de domínio é montada **sem tocar no
banco** (UUIDs, tipo, `Money`, hash do payload).

Dentro de **uma única transação SQL**:

1. **Replay rápido, sem lock**: se já existe transação com `(providerId, idempotencyKey)`, devolve o
   resultado original (ou **409** se o `payloadHash` difere). Duplicatas já commitadas nunca
   disputam a wallet.
2. **Lock da wallet** (`FOR UPDATE`). Wallet inexistente: `WalletNotFoundError` (404), **sem
   persistir nada**, porque a FK `wager_transactions.wallet_id` impede registrar transação de wallet
   inexistente.
3. **`INSERT ... ON CONFLICT DO NOTHING`** na transação. Quem perde uma corrida (duplicata
   simultânea que passou do passo 1) relê o vencedor e vira replay; se o conflito foi no
   `externalTransactionId` com outra chave, é **409**.
4. **`WagerTransactionApplier`** (regra de negócio, na wallet já travada):
    - wallet de outro player: `WALLET_PLAYER_MISMATCH`; moeda diferente da wallet:
      `CURRENCY_MISMATCH`;
    - REFUND/ROLLBACK: resolve a referência por `(providerId, referenceExternalTransactionId)`.
      Ausente ou ainda não terminal: `PENDING_REFERENCE` (ver seção 12). Presente:
      `validateReference` e checagem de reversão prévia (`ALREADY_REVERSED`);
    - LOSS: `PROCESSED` sem mexer no saldo e sem lançamento;
    - demais: `debit` ou `credit` na wallet, `UPDATE` do saldo (com versão esperada), `INSERT` do
      ledger e `markProcessed` com o saldo observado;
    - `InsufficientFundsError` vira `INSUFFICIENT_FUNDS` em BET e `REVERSAL_WOULD_OVERDRAW` em
      reversão (situações operacionalmente diferentes).
5. **Eventos na outbox** (mesma transação). `COMMIT`.

Uma **rejeição de negócio comita**: a transação fica `REJECTED`, auditável, com evento e sem alterar
saldo nem gerar lançamento. Apenas erros de infraestrutura fazem rollback.

**`CreateWallet`**: wallet, transação `OPENING` (provider `INTERNAL`), lançamento `CREDIT` e os
eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na **mesma transação SQL**. Wallet
duplicada (mesmo player e moeda) falha como conflito e não deixa registros parciais.

## 11. Idempotência ✅

- Header `Idempotency-Key` obrigatório e fonte da verdade (entrada HTTP 🔜). Default recomendado:
  `{providerId}:{externalTransactionId}`.
- `payloadHash` = **sha256 (hex)** do **JSON canônico** (chaves ordenadas recursivamente, sem
  espaços, `undefined` omitido) dos campos de negócio: `providerId`, `externalTransactionId`,
  `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado em escala 2) e
  `referenceExternalTransactionId` (`null` se ausente).
- Fora do hash: header `Idempotency-Key`, `idempotencyKey` e metadados de transporte.
- Requisição idêntica devolve a mesma resposta com `idempotentReplay: true`, **incluindo o saldo
  observado naquele momento** (não o saldo atual). Para transações `REJECTED`, o replay devolve o
  `failureCode`.
- A mesma chave com payload diferente é **conflito (409)**, não replay.
- Nenhuma idempotência depende de memória: tudo passa pelos índices únicos do banco, e os testes
  cobrem replay, conflito de payload, conflito de `externalTransactionId` e 50 envios paralelos.

## 12. Referências fora de ordem

REFUND ou ROLLBACK cuja referência ainda não existe (ou ainda não está em estado terminal) é
persistido como `PENDING_REFERENCE`, com contagem de tentativas e `next_reference_attempt_at`
calculado por backoff exponencial (base 2 s, teto 5 min). O evento
`WagerTransactionPendingReference` sai na primeira espera. ✅ (aplicador e persistência; HTTP 202
🔜)

O **worker agendado** 🔜 busca
`WHERE status='PENDING_REFERENCE' AND next_reference_attempt_at <= now() ... FOR UPDATE SKIP LOCKED`
e reaplica a transação pelo **mesmo** `WagerTransactionApplier`, com a wallet travada.

- **Limite**: 8 esperas (aproximadamente 10 minutos acumulados), que cobre atrasos realistas de
  entrega sem manter pendências indefinidamente. Valor configurável por `PENDING_REF_MAX_ATTEMPTS`.
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED` se a
  referência existe mas nunca chegou a um estado terminal) e evento `WagerTransactionRejected`.

## 13. Taxonomia de falhas ✅

Todo `failureCode` é estável e legível por máquina. A ação recomendada ao provedor fica no código
(`FAILURE_CODE_ACTION`), e o compilador exige uma ação para cada código novo.

| failureCode               | Estado                             | Ação do provedor                                             |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `INSUFFICIENT_FUNDS`      | REJECTED                           | desistir                                                     |
| `REVERSAL_WOULD_OVERDRAW` | REJECTED                           | tratar manualmente (suporte)                                 |
| `REFERENCE_NOT_FOUND`     | REJECTED (após esgotar tentativas) | corrigir a referência                                        |
| `REFERENCE_MISMATCH`      | REJECTED                           | corrigir payload (provider, player, wallet, rodada ou moeda) |
| `REFERENCE_NOT_PROCESSED` | REJECTED                           | desistir (referência rejeitada)                              |
| `INVALID_REFERENCE_KIND`  | REJECTED                           | corrigir payload                                             |
| `AMOUNT_MISMATCH`         | REJECTED                           | corrigir valor                                               |
| `ALREADY_REVERSED`        | REJECTED                           | desistir                                                     |
| `WALLET_PLAYER_MISMATCH`  | REJECTED                           | corrigir payload                                             |
| `CURRENCY_MISMATCH`       | REJECTED                           | corrigir payload                                             |
| `INFRA_PERMANENT`         | FAILED                             | contatar suporte                                             |

Wallet inexistente **não** é um `failureCode`: é um erro de endereçamento (404) e não gera registro.
Estados terminais fazem **replay com a mesma chave**; portanto "corrigir payload" significa enviar
uma **nova** transação, com **nova** chave de idempotência.

## 14. Contrato HTTP 🔜

O mapeamento mora em **um único** `DomainExceptionFilter`, o que garante consistência entre todos os
endpoints. A tradução é feita pelo `code` do erro de domínio.

| Situação                                                          | HTTP                         | Retentar?              |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------- |
| Payload inválido / header ausente                                 | 400                          | não; corrigir          |
| Wallet ou transação inexistente                                   | 404                          | não                    |
| Conflito de idempotência / wallet duplicada                       | 409 (campo `code` distingue) | não                    |
| Rejeição por regra de negócio                                     | 422 + `failureCode`          | depende do código      |
| Aceito, aguardando referência                                     | 202                          | consultar depois       |
| Processado, inclusive replay                                      | 200                          | n/a                    |
| Falha transitória (Postgres ou SQS fora, modificação concorrente) | 503 + `Retry-After`          | sim, com a mesma chave |

Endpoints:

- `POST /wallets` · `GET /wallets/:walletId` · `GET /wallets/:walletId/ledger?cursor=&limit=`
  (cursor opaco e estável, baseado em `seq`)
- `POST /wagering/transactions` (header `Idempotency-Key` obrigatório)
- `GET /wagering/transactions/:transactionId` ·
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `POST /wallets/:walletId/reconciliation`
- `GET /health/live` · `GET /health/ready` (abertos; ready verifica Postgres e SQS)

## 15. Mensageria: consumer SQS 🔜

- Filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, com
  `MessageGroupId = walletId`. FIFO é **otimização**: a correção vem do banco.
- Reutiliza o mesmo caso de uso da entrada HTTP.
- Dedup por inbox persistente `(consumerName, messageId)`, gravada na mesma transação financeira.
- **Ack somente após o commit.**
- Classificação de erros: **negócio** (terminal, ack), **transitório** (não deleta; ajusta o
  visibility timeout com backoff), **permanente** (JSON ou schema inválido, tentativa de `OPENING`:
  DLQ).
- `maxReceiveCount = 5` na redrive policy.
- **SIGTERM**: para de buscar mensagens, conclui as em andamento e devolve a visibilidade (0) das
  não iniciadas.
- Redelivery não duplica efeitos: a deduplicação é do banco (inbox e índices únicos).

## 16. Transactional Outbox

**Escrita** ✅: os eventos são gravados na **mesma transação** financeira (wallet, ledger, transação
e outbox), então ou tudo é confirmado, ou nada. `OutboxMessage.id` é o `eventId`, a chave de
deduplicação dos consumidores.

**Publicação** 🔜: o publisher faz
`SELECT ... WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY seq LIMIT n FOR UPDATE SKIP LOCKED`,
publica e marca `published_at`. Falha: `attempts + 1` e novo `next_attempt_at` com backoff
exponencial (`OutboxMessage.scheduleRetry`). `SKIP LOCKED` permite múltiplos publishers concorrentes
sem disputa.

Se o processo morre depois de publicar e antes de marcar, o evento sai de novo: a publicação é
**at-least-once**, e os consumidores deduplicam por `eventId` (`MessageDeduplicationId = eventId` na
fila FIFO de eventos). Nenhum evento é publicado antes do commit.

**Eventos** ✅ (classe abstrata `IntegrationEvent` com uma subclasse por evento; `eventType` e
`version` ficam no tipo; `data` carrega `MoneyProps`, nunca `Money`):

| Evento                             | Quando                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | qualquer transação aplicada, inclusive LOSS                                         |
| `WagerTransactionRejected`         | rejeição por regra de negócio (inclusive `REFERENCE_NOT_FOUND` ao esgotar o limite) |
| `WalletBalanceChanged`             | somente quando o saldo muda                                                         |
| `WagerTransactionPendingReference` | referência ausente (primeira espera)                                                |

Destino: fila `wager-events.fifo` (fila adicional além das duas do enunciado, necessária para ter
para onde publicar).

**Trade-off**: o lock de linha da outbox é mantido durante o publish. Aceito pela simplicidade, com
lotes pequenos.

## 17. Autenticação 🔜

**Não implementada**, conforme o enunciado (não pontua e não deve competir com correção financeira).
Ponto de extensão explícito: `NoOpAuthGuard` e `ProviderIdentityPort`.

**Desenho futuro**: Identity Provider externo (Keycloak/OIDC), JWT validado no guard, claim
`provider_id` cruzado com o `providerId` do body (um provedor não opera em nome de outro). Endpoints
de health permanecem abertos. Mensagens SQS são tratadas como canal interno confiável, mas a
identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio.

## 18. Observabilidade 🔜

- Logs JSON estruturados com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId`. Sem dados sensíveis nem payloads financeiros completos. O `correlationId` já viaja
  nos eventos (`correlationId` e `causationId` no envelope).
- Métricas (Prometheus, `/metrics`): transações por status, duplicatas detectadas, retries,
  mensagens em DLQ, conflitos e espera de lock, outbox lag, latência de processamento e divergências
  de reconciliação.
- Health checks separados: liveness (`/health/live`) e readiness (`/health/ready`, Postgres e SQS).

## 19. Reconciliação 🔜

Recalcula o saldo a partir do ledger (soma de créditos menos débitos) e compara com
`wallets.balance`. Resposta: `storedBalance`, `calculatedBalance`, `difference`, `consistent`,
`checkedEntries`. Divergências **nunca são corrigidas silenciosamente**: são logadas, contabilizadas
em métrica e sinalizadas na resposta.

## 20. Estratégia de testes

| Nível                                     | Status       | Cobertura                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unidade (`bun run test:unit`)             | ✅           | Money (escala e entradas inválidas), Wallet (invariantes, saldo insuficiente, conflito de moeda), WalletLedgerEntry (aritmética e imutabilidade), WagerTransaction (máquina de estados, referências), hash e canonicalização, backoff da outbox |
| Integração de schema (`bun run test:int`) | ✅ 21 testes | cada constraint, trigger de imutabilidade, reversibilidade das migrations, contra Postgres real                                                                                                                                                 |
| Integração de fluxo                       | ✅ parcial   | `CreateWallet` atômico, BET/WIN/LOSS/REFUND/ROLLBACK, rejeições com ledger e eventos, `PENDING_REFERENCE`, replay com saldo observado, conflito de payload e de `externalTransactionId`, wallet inexistente sem persistir                       |
| Concorrência (paralelismo real)           | ✅ parcial   | 2×80, mesma aposta 50×, hot wallet, wallets distintas (várias conexões, um processo)                                                                                                                                                            |
| Mensageria e processos                    | 🔜           | inbox e redelivery, retry e DLQ, publishers concorrentes, ≥ 3 processos, worker morto entre commit e ack, reversão antes da referência pelo worker, reinício com consistência final                                                             |

Invariante verificada ao fim de cada teste: `wallet.balance == saldo reconstruído pelo ledger`.
Nenhum teste substitui Postgres ou SQS por mocks.

## 21. Decisões em aberto

1. **Trigger `BEFORE TRUNCATE`** no ledger: proposto, ainda não aplicado. Se aplicado, os testes não
   podem usar `TRUNCATE` na tabela.

Decisões fechadas nesta etapa: wallet inexistente é 404 sem persistir; replay de transação rejeitada
devolve só o `failureCode`; a fila `wager-events.fifo` e o limite de 8 esperas para
`PENDING_REFERENCE` foram adotados.

## 22. Limitações conhecidas

- Hot wallet é serializada pelo lock pessimista.
- Reversão parcial está fora de escopo (REFUND e ROLLBACK exigem valor igual ao da referência).
- Uma referência só pode ser revertida **uma vez no total** (REFUND ou ROLLBACK, não os dois):
  interpretação adicional adotada para impedir crédito duplicado.
- Replay de transação `REJECTED` não carrega saldo (o saldo observado só existe em `PROCESSED`).
- A outbox mantém lock de linha durante a publicação.
- `TRUNCATE` e remoção do trigger dependem de permissão de role em produção.
- Autenticação não implementada (ponto de extensão documentado).
