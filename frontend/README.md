
3. Create a `.env.local` file from `.env.example` and update any values you need:

- `NEXT_PUBLIC_RPC_URL` — JSON-RPC URL (e.g. `http://localhost:8545` for Hardhat)
- `NEXT_PUBLIC_BACKEND_URL` — backend base URL (e.g. `http://localhost:3000`)
- `NEXT_PUBLIC_SALARY_SCHEDULE`, `NEXT_PUBLIC_PAYROLL_VAULT`, `NEXT_PUBLIC_PAYMENT_VERIFIER` — contract addresses (optional for local preview)
- `NEXT_PUBLIC_STABLECOIN` — stablecoin (devUSDC) address

4. Run the dev server:

```Vibe Coding/blockwage/frontend/package.json#L1-68
npm run dev
```

The app is available at http://localhost:3000 by default.

---

## Build & production

Build the app:

```Vibe Coding/blockwage/frontend/package.json#L1-68
npm run build
npm run start
```

This will serve the production build on port 3000.

---

## Docker (build & run)

You can run the frontend in a Docker container. Example Dockerfile (included below). Build and run:

```Vibe Coding/blockwage/frontend/Dockerfile#L1-200
# Build
docker build -t blockwage-frontend:latest .

# Run (example)
docker run -p 3000:3000 -e NEXT_PUBLIC_BACKEND_URL=http://host.docker.internal:3000 -e NEXT_PUBLIC_RPC_URL=http://host.docker.internal:8545 blockwage-frontend:latest
```

Below is a recommended Dockerfile you can place at `frontend/Dockerfile` (also included here for convenience).

```Vibe Coding/blockwage/frontend/Dockerfile#L1-200
# Stage 1: install dependencies and build
FROM node:18-alpine AS builder

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --silent

# Copy source
COPY . .

# Build assets
RUN npm run build

# Stage 2: production image
FROM node:18-alpine AS runner
WORKDIR /usr/src/app

# Copy built assets and package.json (for start script)
COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/next.config.js ./
COPY --from=builder /usr/src/app/.next ./.next
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/node_modules ./node_modules

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["npm", "run", "start"]
```

Notes:
- Use `host.docker.internal` to reach backend or local RPC from the container on macOS/Windows.
- For Linux, adjust networking or run backend container alongside frontend using docker-compose.

---

## Environment variables

Place them in `.env.local` (do not commit secrets):

- `NEXT_PUBLIC_RPC_URL` — JSON-RPC provider (default `http://localhost:8545`)
- `NEXT_PUBLIC_BACKEND_URL` — backend base URL (default `http://localhost:3000`)
- `NEXT_PUBLIC_SALARY_SCHEDULE` — SalarySchedule contract address
- `NEXT_PUBLIC_PAYROLL_VAULT` — PayrollVault contract address
- `NEXT_PUBLIC_PAYMENT_VERIFIER` — PaymentVerifier contract address
- `NEXT_PUBLIC_STABLECOIN` — Stablecoin token address (e.g. devUSDC)
- `NEXT_PUBLIC_APP_URL` — Public app URL (for shareable claim links)
- `NEXT_PUBLIC_FACILITATOR_EMULATOR_URL` — Optional facilitator emulator
- `NEXT_PUBLIC_DEBUG` — Enable dev debug logs

Keep private keys out of frontend env. Admin actions are wallet-signed in-browser with MetaMask.

---

## How the frontend integrates with the system

- Employer/admin:
  - Connect a Cronos-compatible wallet (MetaMask) in the browser.
  - Use the Employer Dashboard to `assignEmployee`, `depositPayroll` (requires token approval), and `triggerSalaryDue`.
  - These admin actions are performed as wallet-signed transactions against your deployed contracts.

- Employee:
  - Public claim pages are available at `/employee/<address>` on the frontend.
  - The claim page presents an x402-style payload (to, amount, token, periodId).
  - A facilitator or scheduler reads the 402 request and executes the facilitator payment flow.

- Simulator:
  - For demo flows, call the backend `POST /simulate-facilitator` endpoint to generate a mock facilitator proof from the x402 payload.
  - The frontend proxies that call via `/api/simulate-facilitator` to your backend by default (see `next.config.js` rewrites).

---

## Vercel deployment

- Set the NEXT_PUBLIC_* environment variables in your Vercel project settings.
- Deploy the `frontend/` folder as a Next.js project — Vercel will build and publish automatically.
- If your backend is remote, set `NEXT_PUBLIC_BACKEND_URL` to its absolute URL. The frontend includes rewrites to proxy `/api/*` to that backend when configured.

---

## Notes & next steps

- The frontend contains demo helpers and a simulator to test the full x402 flow without a real facilitator. For production, replace the simulator with real facilitator integration (server-side) and verify proofs using `PaymentVerifier` on-chain.
- When you deploy the smart contracts to Cronos testnet, update the `NEXT_PUBLIC_*` env variables to point to the deployed addresses and RPC endpoint.
- For a hardened production deployment:
  - Use HTTPS for your backend and frontend.
  - Keep backend private keys safe (never in the frontend).
  - Configure monitoring and alerting on scheduler/backend.

---

If you want, I can:
- Add a `Docker Compose` setup mapping frontend + backend + scheduler for local end-to-end demos.
- Add a `vercel.json` with rewrites useful for your backend domain.
- Implement CSV export and pagination for the Audit page.
