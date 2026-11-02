# 🦧 Distributed Wagering Processor — Jungle Gaming

Serviço financeiro distribuído de alta performance para processamento de transações de apostas
(_BET_, _WIN_, _LOSS_, _REFUND_, _ROLLBACK_) em tempo real, construído com foco em **precisão
monetária**, **concorrência**, **idempotência persistente** e **consistência eventual com garantia
de ledger imutável**.

---

## 📋 Sumário

- [Visão Geral e Arquitetura](#-visão-geral-e-arquitetura)
- [Tecnologias Utilizadas](#-tecnologias-utilizadas)
- [Pré-requisitos](#-pré-requisitos)
- [Como Executar o Projeto](#-como-executar-o-projeto)
- [Suíte de Testes](#-suíte-de-testes)
- [Endpoints HTTP](#-endpoints-http)
- [Garantias do Sistema e Invariantes](#-garantias-do-sistema-e-invariantes)

---

## 🏛️ Visão Geral e Arquitetura

O sistema adota **Arquitetura Hexagonal (Ports & Adapters)** e **Domain-Driven Design (DDD)**,
garantindo desacoplamento total entre as regras de negócio e os mecanismos de infraestrutura.

```
                  +------------------------+
                  |  HTTP API / SQS Queue  |
                  +-----------+------------+
                              |
                              v
                  +------------------------+
                  |   Application Layer    |
                  |  (Use Cases & Services)|
                  +-----------+------------+
                              |
                              v
                  +------------------------+
                  |      Domain Layer      |
                  | (Wallet, Money, Wager) |
                  +-----------+------------+
                              |
                              v
                  +------------------------+
                  |   Infra & Database     |
                  | (PostgreSQL & Outbox)  |
                  +------------------------+
```

### Principais Padrões Arquiteturais

- **Padrão Inbox / Outbox:** Garantia at-least-once de consumo e publicação de mensagens integradas
  atomicamente à transação SQL do PostgreSQL.
- **Pessimistic Locking por Wallet (`SELECT ... FOR UPDATE`):** Evita _lost updates_ e
  inconsistências em ambientes distribuídos concorrentes mantendo a alta vazão entre carteiras
  distintas.
- **Ledger Imutável (Audit Trail):** O saldo da carteira é garantido por um registro imutável com
  _trigger_ em nível de banco que impede modificações ou exclusões retroativas.

---

## 🛠️ Tecnologias Utilizadas

- **Runtime & Package Manager:** [Bun 1.x](https://bun.sh/)
- **Linguagem:** TypeScript (Strict Mode)
- **Framework:** NestJS
- **Banco de Dados:** PostgreSQL 16 (TypeORM sem `@Entity` — SQL limpo e explícito)
- **Mensageria:** AWS SQS (executado localmente via LocalStack)
- **Containers:** Docker e Docker Compose

---

## ⚡ Pré-requisitos

Certifique-se de ter instalado em sua máquina:

- [Docker Desktop](https://www.docker.com/) e Docker Compose
- [Bun](https://bun.sh/) (opcional se executado dentro dos containers Docker)

---

## 🚀 Como Executar o Projeto

### 1. Clonar o repositório e configurar variáveis

```bash
cp .env.example .env
```

### 2. Subir os serviços com Docker Compose

O comando abaixo subirá o **PostgreSQL**, **LocalStack (SQS)**, a **API HTTP** e o **Worker
assíncrono**:

```bash
docker compose up -d --build
```

As filas SQS serão inicializadas automaticamente através do script `scripts/init-queues.sh`.

### 3. Rodar as Migrations do Banco de Dados

```bash
bun run migration:run
```

---

## 🧪 Suíte de Testes

O projeto contém testes rigorosos cobrindo operações monetárias, cenários de alta concorrência (ex.:
requisições concorrentes disputando o mesmo saldo) e simulação de concorrência real contra bancos de
dados de teste.

### Executar Testes Unitários

Testa as regras de domínio, imutabilidade da classe `Money` e validações de agregados:

```bash
bun run test:unit
```

### Executar Testes de Integração

Executa cenários com PostgreSQL e LocalStack/SQS reais:

```bash
bun run test:int
```

### Executar Testes E2E (End-to-End)

```bash
bun run test:e2e
```

---

## 📡 Endpoints HTTP

A API aceita e retorna valores monetários no formato JSON
`{ "amount": "25.00", "currency": "BRL" }`.

| Método | Rota                                                                  | Descrição                                                                    |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST` | `/wallets`                                                            | Criação de uma nova carteira para o jogador                                  |
| `GET`  | `/wallets/:walletId`                                                  | Consulta os detalhes e o saldo da carteira                                   |
| `GET`  | `/wallets/:walletId/ledger`                                           | Retorna o extrato paginado da carteira via cursor                            |
| `POST` | `/wagering/transactions`                                              | Submete uma transação de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) |
| `GET`  | `/wagering/transactions/:transactionId`                               | Consulta uma transação pelo ID interno                                       |
| `GET`  | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação pelo ID do provedor                                       |
| `POST` | `/wallets/:walletId/reconciliation`                                   | Executa a reconciliação do saldo com base no ledger                          |
| `GET`  | `/health/live`                                                        | Liveness probe do serviço                                                    |
| `GET`  | `/health/ready`                                                       | Readiness probe (valida conexão com PostgreSQL e SQS)                        |

> **Nota de Idempotência:** Todas as chamadas em `POST /wagering/transactions` requerem o cabeçalho
> HTTP `Idempotency-Key`.

---

## 🔒 Garantias do Sistema e Invariantes

1. **Aritmética Exata:** Nenhuma variável monetária utiliza `number`, `float` ou `double`. Toda a
   lógica monetária utiliza centavos inteiros (`bigint`) serializados com escala decimal 2.
2. **Saldo Não-Negativo:** Restrições do schema do banco (`CHECK (balance >= 0)`) e invariantes no
   domínio impedem saldos negativos.
3. **Idempotência Persistente:** O replay de transações com a mesma `Idempotency-Key` e mesmo
   payload devolve exatamente o resultado original, sem duplicar efeitos financeiros.
4. **Resiliência a Falhas:** Registros na Outbox garantem que mensagens de eventos não sejam
   perdidas mesmo em falhas ou crashes da aplicação.
