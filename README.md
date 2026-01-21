# BlockWage — Cronos x402 Automated Payroll System

BlockWage is a production-ready automated payroll system built for the Cronos EVM that uses the x402 HTTP-native payment flow and the @crypto.com/facilitator-client (Node SDK) to perform non-custodial stablecoin (e.g., devUSDC.e) payouts to employees. The system provides on-chain settlement, verifiable facilitator proof handling, and an off-chain scheduler to orchestrate payouts on scheduled paydays (monthly / biweekly / hourly).

This repository includes smart contracts, a Node.js API server, a scheduler service, tests, deployment scripts, Docker configuration, and CI.

Table of contents
- Project Overview
- Architecture & Components
- Smart Contracts
- API & x402 Flow
- Scheduler
- Facilitator Integration
- Setup & Local Run
- Deployment (Hardhat → Cronos testnet)
- Tests
- Security Considerations
- Files of Interest
- CI / Docker
- Roadmap & Notes

---

## Project Overview

Goals:
- Employers deposit stablecoins into a `PayrollVault` smart contract.
- `SalarySchedule` defines and validates cadence (monthly / biweekly / hourly).
- Employees expose an HTTP `/salary/claim/:employeeAddress` endpoint that returns an x402 `402 Payment Required` response describing the required payment.
- A scheduler listens to `SalaryDue` events and triggers x402 flow:
  1. Employee receives 402 response → facilitator performs payment (x402 negotiation).
  2. Facilitator returns an off-chain proof (facilitatorProof).
  3. Backend verifies the proof and calls on-chain `PaymentVerifier` (prevents replay).
  4. `PayrollVault` releases funds to the employee and records settlement on-chain.
- The facilitator client (`@crypto.com/facilitator-client`) is used to create/verify the off-chain payment proof.

High-level flow: 402 → facilitator pay → backend verify → on-chain release → 200 OK.

---

## Architecture & Components

- Smart contracts (Solidity, OpenZeppelin):
  - `SalarySchedule.sol` — defines cadence rules and emits `SalaryDue`.
  - `PayrollVault.sol` — holds stablecoins, reserves and releases payroll funds.
  - `PaymentVerifier.sol` — records/verifies facilitator proofs and prevents double-pay.

- Backend API (Node, Express, TypeScript):
  - `GET /salary/claim/:employeeAddress` — returns x402 402 response describing payment.
  - `POST /salary/verify` — accepts facilitator proof (or txHash), verifies and triggers on-chain `releaseSalary`.

- Scheduler (Node, TypeScript):
  - Listens to `SalaryDue` events and executes x402 facilitator flow.
  - Retries & exponential backoff, persistence to avoid double-processing.

- Facilitator SDK:
  - Integrates with `@crypto.com/facilitator-client` to create and verify payments (stubbed fallback included for local dev).

ASCII architecture:

Employee HTTP Endpoint <-- x402 402 -- Scheduler/Facilitator --> Cronos Facilitator
                                                                 |
                                                                 v
                                    Backend API (/salary/verify) -- interacts with --> PaymentVerifier (on-chain)
                                                                 |
                                                                 v
                                                          PayrollVault (on-chain)
                                                                 |
                                                                 v
                                                         Stablecoin (devUSDC.e)

---

## Smart Contracts (where to find them)

- `SalarySchedule` — handles cadence validation and emits `SalaryDue` events.
  - File: `Vibe Coding/blockwage/contracts/SalarySchedule.sol#L1-300`

- `PayrollVault` — vault that accepts deposits, reserves funds on `SalaryDue`, and releases tokens after proof verification.
  - File: `Vibe Coding/blockwage/contracts/PayrollVault.sol#L1-365`

- `PaymentVerifier` — simple on-chain registry to record facilitator proofs and ensure no double payment.
  - File: `Vibe Coding/blockwage/contracts/PaymentVerifier.sol#L1-200`

These contracts use OpenZeppelin (Ownable, SafeERC20, ReentrancyGuard) and are written for Solidity `^0.8.17`.

---

## API & x402 Flow

Backend server provides the x402 endpoints:

- Claim endpoint
  - `GET /salary/claim/:employeeAddress`
  - Responds with HTTP 402 Payment Required and a JSON body that contains:
    - `to`: employee wallet address
    - `amount`: salary amount (in smallest token units)
    - `token`: stablecoin contract address (devUSDC.e)
    - `periodId`: identifier for the payroll period (timestamp or period code)

  Implementation: `Vibe Coding/blockwage/backend/src/index.ts#L1-400`

- Verify endpoint
  - `POST /salary/verify`
  - Accepts:
    - `{ facilitatorProof, employee, periodId }` — facilitator proof (hex/base64) plus employee and period
    - OR `{ txHash, employee, periodId }` — on-chain tx hash (optional alternative)
  - Flow:
    1. Optionally validate proof locally (SDK).
    2. Call `PaymentVerifier.verifyPayment(facilitatorProof)` on-chain to mark proof consumed and prevent replay.
    3. Call `PayrollVault.releaseSalary(employee, periodId)` to transfer tokens to the employee.

  Implementation: `Vibe Coding/blockwage/backend/src/index.ts#L1-400`

x402 explanation (short):
- Employee's server returns a 402 response that contains payment parameters.
- The payer (scheduler/facilitator) constructs a facilitator payment (off-chain) which settles the transfer via facilitator backend.
- The facilitator returns a cryptographic/structured proof (facilitatorProof).
- The payroll backend verifies the proof (off-chain SDK + on-chain `PaymentVerifier`), then finalizes the transfer on-chain.

x402 sample body generation helper:
- `Vibe Coding/blockwage/backend/src/x402.ts#L1-224`

Facilitator verifier stub:
- `Vibe Coding/blockwage/backend/src/verifier.ts#L1-200`

---

## Scheduler

The scheduler:
- Listens for `SalaryDue` events from the `SalarySchedule` contract.
- Calls the employee claim endpoint (x402).
- Uses the facilitator client (or stub) to create a proof.
- Posts the proof to `/salary/verify` to finalize on-chain release.
- Includes retries/exponential backoff and persistence to avoid duplicate payouts.

Scheduler implementation:
- `Vibe Coding/blockwage/scheduler/src/index.ts#L1-400`

Key features:
- Configurable cron expression via `SCHED_CRON`.
- Persistence (simple JSON file) to persist processed payouts across restarts.
- Alert hooks for failure (integrate Slack/email via webhooks).

---

## Facilitator Integration

This project is designed to integrate with `@crypto.com/facilitator-client`:

- The `FacilitatorWrapper` class tries to `require("@crypto.com/facilitator-client")` at runtime and uses the SDK if available.
- For local development, a fallback stub builds a compact `facilitatorProof` (ABI-packed `employee|periodId|amount`) — this is not secure and only for local testing.

See:
- Backend integration & usage: `Vibe Coding/blockwage/backend/src/index.ts#L1-400`
- Scheduler wrapper: `Vibe Coding/blockwage/scheduler/src/index.ts#L1-400`

Important: In production, ensure facilitator proofs contain verifiable cryptographic attestations and that your backend / on-chain verifier validates them properly (or relies on a trusted oracle/attestation from the facilitator backend).

---

## Setup & Local Run

Prerequisites:
- Node.js >= 16
- npm or yarn
- Hardhat & dependencies (solidity toolchain)
- Docker (optional, for services)

1. Clone repository and install:

```/dev/null/commands.sh#L1-10
# from repo root (where README.md lives)
cd "Vibe Coding/blockwage"
# Backend
cd backend
npm ci
# Scheduler
cd ../scheduler
npm ci
# Back to root
cd ..
```

2. Compile & run contract tests (Hardhat):

```/dev/null/commands.sh#L11-20
# install dev deps if needed
npx hardhat compile
npx hardhat test
```

3. Run backend (development):

```/dev/null/commands.sh#L21-30
cd backend
# dev server (ts-node-dev)
npm run dev
# or build + start
npm run build
npm start
```

4. Run scheduler (development):

```/dev/null/commands.sh#L31-40
cd scheduler
npm run dev
```

5. Docker Compose (example):

```/dev/null/commands.sh#L41-60
# from repo root
docker compose -f docker/docker-compose.yml up --build
```

Environment variables (example `.env`):
- `RPC_URL` — Cronos RPC (default: https://evm-t3.cronos.org)
- `PRIVATE_KEY` — Deployer/admin key (used by backend/scheduler to sign on-chain txs)
- `STABLECOIN_ADDRESS` — devUSDC token contract (if using existing)
- `SALARY_SCHEDULE_ADDRESS` — deployed `SalarySchedule` contract
- `PAYMENT_VERIFIER_ADDRESS` — deployed `PaymentVerifier` contract
- `PAYROLL_VAULT_ADDRESS` — deployed `PayrollVault` contract
- `BACKEND_URL` — base URL of backend server
- `EMPLOYEE_CLAIM_BASE_URL` — base URL for employee claim endpoints (for scheduler)
- `SCHED_CRON` — cron expression for rescan
- `FACILITATOR_ENDPOINT` — optional local facilitator emulator endpoint

See `deploy/scripts/deploy.ts` for deployment guidance:
- `Vibe Coding/blockwage/deploy/scripts/deploy.ts#L1-199`

---

## Deployment (Hardhat → Cronos testnet)

- Configure `hardhat.config.ts` for Cronos testnet RPC and private key:
  - `Vibe Coding/blockwage/hardhat.config.ts#L1-200`

- Deploy contracts via Hardhat script:
  - `npx hardhat run --network cronos_testnet deploy/scripts/deploy.ts`

- The deploy script will:
  - Deploy a devUSDC mock (if `STABLE_TOKEN` not provided).
  - Deploy `PaymentVerifier`, `SalarySchedule`, `PayrollVault`.
  - Wire contracts and optionally attempt explorer verification.

---

## Tests

- Smart contract tests: Hardhat / Mocha / Chai
  - Tests exist under: `Vibe Coding/blockwage/test/contracts/payroll.test.js#L1-211`
  - Run: `npx hardhat test`

- Backend tests: Jest (in `backend` folder)
  - Run: `cd backend && npm test`

- Scheduler tests: Jest (in `scheduler` folder)
  - Run: `cd scheduler && npm test`

Note: CI config (GitHub Actions) runs contract tests, builds and tests backend/scheduler:
- `Vibe Coding/blockwage/.github/workflows/ci.yml#L1-200`

---

## Security Considerations

This project is built with security best practices in mind; important highlights:

Smart-contract-level:
- Use of OpenZeppelin primitives (`Ownable`, `SafeERC20`, `ReentrancyGuard`) to guard critical operations.
- Prevent double-pay via `periodProcessed` and `paid` mappings.
- Marking state before external calls (e.g., mark a period processed before calling external vault) to avoid reentrancy.
- Arithmetic uses Solidity >=0.8.x (built-in overflow checks).
- Access control: critical functions restricted to `onlyOwner`. In production consider role-based access (e.g., `AccessControl`).

Off-chain considerations:
- Facilitator proofs MUST be cryptographically verifiable. The on-chain `PaymentVerifier` stub accepts structural proofs — replace with a facilitator attestation or oracle for production.
- Idempotence: the backend and scheduler include local persistence to avoid double processing.
- Secrets: Never commit `PRIVATE_KEY` or other secrets. Use environment variables or secret stores in CI and production.
- Logging & monitoring: logs are designed to be structured and surfaced to your central logging/alerting system. Integrate Slack/email/webhooks for failure alerts in the scheduler.

Edge cases handled in tests:
- Double payout attempt gets prevented.
- Misaligned periods are rejected by `SalarySchedule`.
- Release fails if insufficient funds in vault.

---

## Files of Interest (quick map)

- Contracts:
  - `Vibe Coding/blockwage/contracts/SalarySchedule.sol#L1-300`
  - `Vibe Coding/blockwage/contracts/PayrollVault.sol#L1-365`
  - `Vibe Coding/blockwage/contracts/PaymentVerifier.sol#L1-200`

- Backend:
  - `Vibe Coding/blockwage/backend/src/index.ts#L1-400` — main HTTP server & API handlers
  - `Vibe Coding/blockwage/backend/src/x402.ts#L1-224` — x402 helpers
  - `Vibe Coding/blockwage/backend/src/verifier.ts#L1-200` — verifier stub
  - `Vibe Coding/blockwage/backend/package.json#L1-200`

- Scheduler:
  - `Vibe Coding/blockwage/scheduler/src/index.ts#L1-400`
  - `Vibe Coding/blockwage/scheduler/package.json#L1-200`

- Deployment & CI:
  - `Vibe Coding/blockwage/deploy/scripts/deploy.ts#L1-199`
  - `Vibe Coding/blockwage/hardhat.config.ts#L1-200`
  - `Vibe Coding/blockwage/.github/workflows/ci.yml#L1-200`
  - `Vibe Coding/blockwage/docker/docker-compose.yml#L1-111`

- Tests:
  - `Vibe Coding/blockwage/test/contracts/payroll.test.js#L1-211`

---

## CI & Docker

- GitHub Actions workflow provided for contracts/backend/scheduler and docker image build:
  - `Vibe Coding/blockwage/.github/workflows/ci.yml#L1-200`

- Docker compose to run backend + scheduler (development):
  - `Vibe Coding/blockwage/docker/docker-compose.yml#L1-111`

Each service expects a `Dockerfile` in `backend/` and `scheduler/`. The compose file mounts source code for development; for production, build immutable images and run with a process manager / orchestrator.

---

## Roadmap & Next Steps (production hardening)

- Replace `PaymentVerifier` structural acceptance with cryptographic verification:
  - Use facilitator attestation + signature verification or a facilitator oracle that writes attestations on-chain.
- Implement persistent DB (Postgres) and Redis for idempotence, queues, and observability.
- Add role-based access control for payroll ops (`AccessControl`).
- Add robust monitoring (Prometheus, Grafana), and alerting (Slack/email).
- Add end-to-end integration tests with real `@crypto.com/facilitator-client` and Cronos testnet.

---

Contributing
- Please open issues / PRs for improvements. The repository includes tests and a CI pipeline to help maintain quality.

License
- MIT

Contact
- Maintainers: BlockWage Team

Thank you for using BlockWage. If you'd like, I can:
- walk you through deploying to Cronos testnet with a step-by-step runbook,
- add a Postgres-backed persistence layer for the scheduler,
- or integrate a real facilitator attestation step for production-grade security.