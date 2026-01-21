```Vibe Coding/blockwage/backend/src/index.ts#L1-400
import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { ethers } from "ethers";
import winston from "winston";
import bodyParser from "body-parser";

dotenv.config();

/**
 * BlockWage - Express HTTP server
 *
 * Endpoints:
 *  - GET  /salary/claim/:employeeAddress   -> returns x402 402 Payment Required response describing how to pay employee
 *  - POST /salary/verify                   -> accept facilitator proof or txHash, verifies and triggers on-chain release
 *
 * Environment variables expected:
 *  - RPC_URL                      Cronos RPC endpoint (testnet)
 *  - PRIVATE_KEY                   Private key used to sign on-chain release txs (owner/admin)
 *  - SALARY_SCHEDULE_ADDRESS       Deployed SalarySchedule contract address
 *  - PAYMENT_VERIFIER_ADDRESS      Deployed PaymentVerifier contract address
 *  - PAYROLL_VAULT_ADDRESS         Deployed PayrollVault contract address
 *  - STABLECOIN_ADDRESS            devUSDC.e token address used for payouts
 *  - PORT                          HTTP server port (default 3000)
 *
 * Notes:
 *  - This file implements facilitator-client integration as a runtime attempt to require the SDK.
 *    If the SDK is not available, a simple stub is used so the app remains testable.
 *  - Idempotence for proof handling is implemented with an in-memory cache (Map). For production,
 *    use a persistent datastore (Postgres/Redis) so restarts do not lose state.
 */

/* ===========================
   Logging
   =========================== */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message, ...meta }) =>
        `${timestamp} [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`
    )
  ),
  transports: [new winston.transports.Console()],
});

/* ===========================
   Environment & Provider
   =========================== */
const RPC_URL = process.env.RPC_URL || "https://evm-t3.cronos.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const SALARY_SCHEDULE_ADDRESS = process.env.SALARY_SCHEDULE_ADDRESS || "";
const PAYMENT_VERIFIER_ADDRESS = process.env.PAYMENT_VERIFIER_ADDRESS || "";
const PAYROLL_VAULT_ADDRESS = process.env.PAYROLL_VAULT_ADDRESS || "";
const STABLECOIN_ADDRESS = process.env.STABLECOIN_ADDRESS || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!PRIVATE_KEY) {
  logger.warn("PRIVATE_KEY not set - some endpoints requiring on-chain signatures will fail");
}

if (!SALARY_SCHEDULE_ADDRESS) {
  logger.warn("SALARY_SCHEDULE_ADDRESS not set - GET /salary/claim will be limited");
}

if (!STABLECOIN_ADDRESS) {
  logger.warn("STABLECOIN_ADDRESS not set - x402 responses may have empty token");
}

/* ===========================
   Minimal ABIs (subset of contract interfaces used)
   These match the contracts implemented in the smart contract files.
   =========================== */
const SalaryScheduleABI = [
  // function getEmployee(address) external view returns (uint256 salary, uint8 cadence, uint256 lastPaid, bool exists)
  "function getEmployee(address) view returns (uint256,uint8,uint256,bool)",
  // function nextExpectedPeriod(address) view returns (uint256)
  "function nextExpectedPeriod(address) view returns (uint256)",
];

const PaymentVerifierABI = [
  // function isVerified(address employee, uint256 periodId) external view returns (bool)
  "function isVerified(address,uint256) view returns (bool)",
  // function verifyPayment(bytes calldata) external returns (bool)
  "function verifyPayment(bytes) returns (bool)",
];

const PayrollVaultABI = [
  // function releaseSalary(address employee, uint256 periodId) external
  "function releaseSalary(address,uint256) external",
];

/* ===========================
   Ethers setup
   =========================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : undefined;

let salaryScheduleContract: ethers.Contract | undefined = undefined;
let paymentVerifierContract: ethers.Contract | undefined = undefined;
let payrollVaultContract: ethers.Contract | undefined = undefined;

try {
  if (SALARY_SCHEDULE_ADDRESS) {
    salaryScheduleContract = new ethers.Contract(SALARY_SCHEDULE_ADDRESS, SalaryScheduleABI, provider);
  }
  if (PAYMENT_VERIFIER_ADDRESS) {
    paymentVerifierContract = new ethers.Contract(PAYMENT_VERIFIER_ADDRESS, PaymentVerifierABI, signer ?? provider);
  }
  if (PAYROLL_VAULT_ADDRESS) {
    payrollVaultContract = new ethers.Contract(PAYROLL_VAULT_ADDRESS, PayrollVaultABI, signer ?? provider);
  }
} catch (err) {
  logger.error("Failed to instantiate contracts", { error: err });
}

/* ===========================
   Facilitator client wrapper (attempt to use @crypto.com/facilitator-client)
   Fallback to a stub that simulates verify action.
   =========================== */
type FacilitatorClientType = {
  createPayment?: (opts: any) => Promise<any>;
  verifyProof?: (proof: string) => Promise<boolean>;
};

class FacilitatorWrapper {
  client: FacilitatorClientType | null = null;
  available = false;

  constructor() {
    try {
      // Try to require the SDK dynamically. In environments where it is installed this will succeed.
      // We avoid top-level static import to keep the server runnable during development without the SDK.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require("@crypto.com/facilitator-client");
      // The actual SDK shapes may vary; adapt as needed. We'll wrap basic operations used by the app.
      this.client = {
        createPayment: sdk.createPayment ? sdk.createPayment.bind(sdk) : undefined,
        verifyProof: sdk.verifyProof ? sdk.verifyProof.bind(sdk) : undefined,
      };
      this.available = true;
      logger.info("Facilitator SDK loaded");
    } catch (e) {
      // Not fatal: use stub behavior
      this.client = null;
      this.available = false;
      logger.warn("Facilitator SDK not available; using local stub behavior", { reason: (e as Error).message });
    }
  }

  async verifyProof(proofHex: string): Promise<boolean> {
    // If SDK available and exposes verifyProof, use it
    if (this.available && this.client && this.client.verifyProof) {
      try {
        return await this.client.verifyProof(proofHex);
      } catch (err) {
        logger.error("Facilitator SDK verifyProof failed", { error: err });
        return false;
      }
    }

    // Fallback: naive local stub - treat non-empty hex as valid
    if (!proofHex) return false;
    // Basic sanity: must be hex-like string (0x...) or base64; we accept
    return true;
  }
}

const facilitator = new FacilitatorWrapper();

/* ===========================
   In-memory idempotence caches
   - verifiedProofs: proofs that have been verified
   - processedPayouts: (employee|periodId) pairs already processed
   NOTE: For production use persistent storage (DB/Redis)
   =========================== */
const verifiedProofs = new Set<string>();
const processedPayouts = new Set<string>();

/* ===========================
   Express app
   =========================== */
const app = express();
app.use(bodyParser.json());

// Simple request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`HTTP ${req.method} ${req.path}`, { query: req.query, body: req.body });
  next();
});

/**
 * GET /salary/claim/:employeeAddress
 *
 * Returns a 402 Payment Required response (x402 style) when there's a salary due for the employee.
 * The caller (employee or facilitator) should use the provided details to initiate a facilitator payment.
 */
app.get("/salary/claim/:employeeAddress", async (req: Request, res: Response) => {
  const { employeeAddress } = req.params;

  // Validate address
  if (!ethers.isAddress(employeeAddress)) {
    return res.status(400).json({ error: "invalid-employee-address" });
  }

  try {
    // If SalarySchedule contract is available, fetch employee metadata
    let salary = "0";
    let periodId = 0;
    let exists = false;

    if (salaryScheduleContract) {
      try {
        // call getEmployee
        const employeeInfo: [ethers.BigNumberish, number, ethers.BigNumberish, boolean] =
          await salaryScheduleContract.getEmployee(employeeAddress);
        const [salaryBn, cadence, lastPaid, existsFlag] = employeeInfo;
        exists = existsFlag;
        salary = salaryBn.toString();
      } catch (err) {
        logger.warn("getEmployee call failed; falling back to nextExpectedPeriod", { error: (err as Error).message });
      }

      try {
        const nextPeriod: ethers.BigNumberish = await salaryScheduleContract.nextExpectedPeriod(employeeAddress);
        periodId = Number(nextPeriod.toString());
      } catch (err) {
        logger.warn("nextExpectedPeriod call failed", { error: (err as Error).message });
        periodId = Math.floor(Date.now() / 1000); // fallback to now
      }
    } else {
      logger.warn("SalarySchedule contract not configured; returning best-effort x402 response");
      // Best-effort fallback: no on-chain info available => ask caller to provide amount via query param
      salary = req.query.amount ? String(req.query.amount) : "0";
      periodId = Math.floor(Date.now() / 1000);
    }

    // If no salary assigned, return 404
    if (salary === "0") {
      return res.status(404).json({ error: "no-salary-assigned", message: "No salary information available for this employee" });
    }

    // Build x402 style 402 response body
    const x402Body = {
      to: employeeAddress,
      amount: salary,
      token: STABLECOIN_ADDRESS,
      periodId,
      currency: "USDC", // human friendly
    };

    // x402 uses HTTP 402 Payment Required. We include JSON body that facilitator/scheduler can interpret.
    res.status(402).set("Content-Type", "application/x402+json").json({
      code: 402,
      message: "Payment Required",
      x402: x402Body,
    });
  } catch (err) {
    logger.error("Error in /salary/claim handler", { error: (err as Error).message });
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /salary/verify
 *
 * Accepts:
 *   - { facilitatorProof: string (hex/base64), employee: string, periodId: number }
 *   OR
 *   - { txHash: string, employee: string, periodId: number }
 *
 * Flow:
 *  1. Verify facilitator proof (via SDK wrapper or PaymentVerifier on-chain)
 *  2. Ensure idempotence (don't process same proof / employee+period twice)
 *  3. Call PaymentVerifier.verifyPayment(...) on-chain (marks proof consumed)
 *  4. Call PayrollVault.releaseSalary(employee, periodId) to trigger transfer on-chain
 *  5. Return success with txHash and on-chain receipt details
 */
app.post("/salary/verify", async (req: Request, res: Response) => {
  const { facilitatorProof, txHash, employee, periodId } = req.body;

  if (!employee || !ethers.isAddress(employee)) {
    return res.status(400).json({ error: "invalid-employee" });
  }
  if (!periodId) {
    return res.status(400).json({ error: "missing-periodId" });
  }

  try {
    // Idempotence key for (employee, periodId) string
    const payoutKey = `${employee.toLowerCase()}:${periodId}`;
    if (processedPayouts.has(payoutKey)) {
      logger.info("Payout already processed; returning idempotent success", { payoutKey });
      return res.status(200).json({ result: "already_processed", payoutKey });
    }

    // If txHash is provided we can attempt to verify on-chain receipt (basic flow)
    if (txHash) {
      logger.info("txHash provided; verifying transaction", { txHash });

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return res.status(404).json({ error: "tx-not-found" });
      }

      // Basic checks: ensure tx succeeded
      if (receipt.status !== 1) {
        return res.status(400).json({ error: "tx-failed", txHash });
      }

      // For stronger verification, you'd decode logs/events to confirm PaymentVerifier registration,
      // or that facilitator proof was recorded. For now, we accept successful tx as proof.
      processedPayouts.add(payoutKey);
      logger.info("Payout marked processed (via txHash)", { payoutKey, txHash });
      return res.status(200).json({ result: "ok", txHash });
    }

    // Otherwise we expect facilitatorProof
    if (!facilitatorProof) {
      return res.status(400).json({ error: "missing-facilitatorProof-or-txHash" });
    }

    // Prevent reprocessing the same raw proof
    if (verifiedProofs.has(facilitatorProof)) {
      logger.info("Proof already verified earlier; proceeding to safe on-chain release if needed");
    } else {
      // Use optional SDK to verify proof format / signature
      const sdkOk = await facilitator.verifyProof(facilitatorProof);
      if (!sdkOk) {
        logger.warn("Facilitator SDK reject proof; awating on-chain verifier", { proofSnippet: facilitatorProof.slice(0, 20) });
        // We still proceed to call on-chain verifyPayment for authoritative verification (PaymentVerifier)
      }
      // Mark as locally verified for idempotence
      verifiedProofs.add(facilitatorProof);
    }

    // Call on-chain PaymentVerifier.verifyPayment(facilitatorProof) to mark proof consumed & prevent replay
    if (!paymentVerifierContract) {
      logger.error("PaymentVerifier contract not configured");
      return res.status(500).json({ error: "payment_verifier_not_configured" });
    }
    if (!signer) {
      logger.error("On-chain signer not configured (missing PRIVATE_KEY)");
      return res.status(500).json({ error: "server_no_signer" });
    }

    // Send verifyPayment tx
    logger.info("Calling PaymentVerifier.verifyPayment on-chain", { verifier: PAYMENT_VERIFIER_ADDRESS });
    const verifyTx = await paymentVerifierContract.connect(signer).verifyPayment(ethers.getBytes(facilitatorProof));
    const verifyReceipt = await verifyTx.wait();
    logger.info("PaymentVerifier.verifyPayment tx mined", { txHash: verifyReceipt.transactionHash });

    // After proof accepted on-chain, trigger vault release
    if (!payrollVaultContract) {
      logger.error("PayrollVault contract not configured");
      return res.status(500).json({ error: "payroll_vault_not_configured" });
    }

    // releaseSalary is owner-only; server must be owner or operate via admin signer
    logger.info("Calling PayrollVault.releaseSalary to release funds", { vault: PAYROLL_VAULT_ADDRESS, employee, periodId });
    const releaseTx = await payrollVaultContract.connect(signer).releaseSalary(employee, BigInt(periodId));
    const releaseReceipt = await releaseTx.wait();

    // Mark payout processed to ensure idempotence
    processedPayouts.add(payoutKey);

    logger.info("Salary released successfully", { payoutKey, releaseTxHash: releaseReceipt.transactionHash });

    return res.status(200).json({
      result: "ok",
      releaseTxHash: releaseReceipt.transactionHash,
      verifyTxHash: verifyReceipt.transactionHash,
      payoutKey,
    });
  } catch (err) {
    logger.error("Error in /salary/verify handler", { error: (err as Error).message, body: req.body });
    return res.status(500).json({ error: "internal_error", reason: (err as Error).message });
  }
});

/* ===========================
   Health & readiness endpoints
   =========================== */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

/* ===========================
   Error handler
   =========================== */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", { err: err?.stack ?? err });
  res.status(500).json({ error: "internal_server_error" });
});

/* ===========================
   Start server
   =========================== */
app.listen(PORT, () => {
  logger.info(`BlockWage backend listening on port ${PORT}`);
  logger.info(`Configured contracts: SalarySchedule=${SALARY_SCHEDULE_ADDRESS} PaymentVerifier=${PAYMENT_VERIFIER_ADDRESS} PayrollVault=${PAYROLL_VAULT_ADDRESS}`);
});
