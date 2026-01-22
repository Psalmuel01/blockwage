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
        `${timestamp} [${level}] ${message} ${
          Object.keys(meta).length ? JSON.stringify(meta) : ""
        }`
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
  logger.warn(
    "PRIVATE_KEY not set - some endpoints requiring on-chain signatures will fail"
  );
}

if (!SALARY_SCHEDULE_ADDRESS) {
  logger.warn(
    "SALARY_SCHEDULE_ADDRESS not set - GET /salary/claim will be limited"
  );
}

if (!STABLECOIN_ADDRESS) {
  logger.warn(
    "STABLECOIN_ADDRESS not set - x402 responses may have empty token"
  );
}

/* ===========================
   Minimal ABIs (subset of contract interfaces used)
   =========================== */
const SalaryScheduleABI = [
  "function getEmployee(address) view returns (uint256,uint8,uint256,bool)",
  "function nextExpectedPeriod(address) view returns (uint256)",
];

const PaymentVerifierABI = [
  "function isVerified(address,uint256) view returns (bool)",
  "function verifyPayment(bytes calldata) returns (bool)",
];

const PayrollVaultABI = ["function releaseSalary(address,uint256)"];

/* ===========================
   Ethers setup
   =========================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = PRIVATE_KEY
  ? new ethers.Wallet(PRIVATE_KEY, provider)
  : undefined;

let salaryScheduleContract: ethers.Contract | undefined;
let paymentVerifierContract: ethers.Contract | undefined;
let payrollVaultContract: ethers.Contract | undefined;

try {
  if (SALARY_SCHEDULE_ADDRESS) {
    salaryScheduleContract = new ethers.Contract(
      SALARY_SCHEDULE_ADDRESS,
      SalaryScheduleABI,
      provider
    );
  }
  if (PAYMENT_VERIFIER_ADDRESS && signer) {
    paymentVerifierContract = new ethers.Contract(
      PAYMENT_VERIFIER_ADDRESS,
      PaymentVerifierABI,
      signer
    );
  }
  if (PAYROLL_VAULT_ADDRESS && signer) {
    payrollVaultContract = new ethers.Contract(
      PAYROLL_VAULT_ADDRESS,
      PayrollVaultABI,
      signer
    );
  }
} catch (err) {
  logger.error("Failed to instantiate contracts", { error: err });
}

/* ===========================
   Facilitator client wrapper
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
      // Try to require the SDK dynamically
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require("@crypto.com/facilitator-client");
      this.client = {
        createPayment: sdk.createPayment
          ? sdk.createPayment.bind(sdk)
          : undefined,
        verifyProof: sdk.verifyProof ? sdk.verifyProof.bind(sdk) : undefined,
      };
      this.available = true;
      logger.info("Facilitator SDK loaded");
    } catch (e) {
      this.client = null;
      this.available = false;
      logger.warn("Facilitator SDK not available; using local stub behavior", {
        reason: (e as Error).message,
      });
    }
  }

  async verifyProof(proofHex: string): Promise<boolean> {
    if (this.available && this.client?.verifyProof) {
      try {
        return await this.client.verifyProof(proofHex);
      } catch (err) {
        logger.error("Facilitator SDK verifyProof failed", { error: err });
        return false;
      }
    }
    // Fallback: naive local stub - treat non-empty hex as valid
    return !!proofHex;
  }
}

const facilitator = new FacilitatorWrapper();

/* ===========================
   In-memory idempotence caches
   NOTE: For production use persistent storage (DB/Redis)
   =========================== */
const verifiedProofs = new Set<string>();
const processedPayouts = new Set<string>();

/* ===========================
   Express app
   =========================== */
const app = express();
app.use(bodyParser.json());

// Request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`HTTP ${req.method} ${req.path}`, {
    query: req.query,
    body: req.body,
  });
  next();
});

/**
 * GET /salary/claim/:employeeAddress
 *
 * Returns a 402 Payment Required response (x402 style) when there's a salary due for the employee.
 */
app.get(
  "/salary/claim/:employeeAddress",
  async (req: Request, res: Response) => {
    const { employeeAddress } = req.params;

    if (!ethers.isAddress(employeeAddress)) {
      return res.status(400).json({ error: "invalid-employee-address" });
    }

    try {
      let salary = "0";
      let periodId = 0;

      if (salaryScheduleContract) {
        try {
          const employeeInfo = (await salaryScheduleContract.getEmployee(
            employeeAddress
          )) as [bigint, number, bigint, boolean];
          const [salaryBn, , , existsFlag] = employeeInfo;

          if (!existsFlag) {
            return res.status(404).json({
              error: "no-salary-assigned",
              message: "No salary information available for this employee",
            });
          }

          salary = salaryBn.toString();
        } catch (err) {
          logger.warn("getEmployee call failed", {
            error: (err as Error).message,
          });
        }

        try {
          const nextPeriod = (await salaryScheduleContract.nextExpectedPeriod(
            employeeAddress
          )) as bigint;
          periodId = Number(nextPeriod.toString());
        } catch (err) {
          logger.warn("nextExpectedPeriod call failed", {
            error: (err as Error).message,
          });
          periodId = Math.floor(Date.now() / 1000);
        }
      } else {
        logger.warn(
          "SalarySchedule contract not configured; returning best-effort x402 response"
        );
        salary = req.query.amount ? String(req.query.amount) : "0";
        periodId = Math.floor(Date.now() / 1000);
      }

      if (salary === "0") {
        return res.status(404).json({
          error: "no-salary-assigned",
          message: "No salary information available for this employee",
        });
      }

      const x402Body = {
        to: employeeAddress,
        amount: salary,
        token: STABLECOIN_ADDRESS,
        periodId,
        currency: "USDC",
      };

      return res.status(402).set("Content-Type", "application/x402+json").json({
        code: 402,
        message: "Payment Required",
        x402: x402Body,
      });
    } catch (err) {
      logger.error("Error in /salary/claim handler", {
        error: (err as Error).message,
      });
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

/**
 * POST /salary/verify
 *
 * Accepts:
 *   - { facilitatorProof: string, employee: string, periodId: number }
 *   OR
 *   - { txHash: string, employee: string, periodId: number }
 *
 * Flow:
 *  1. Verify facilitator proof
 *  2. Ensure idempotence
 *  3. Call PaymentVerifier.verifyPayment on-chain
 *  4. Call PayrollVault.releaseSalary to trigger transfer
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
    const payoutKey = `${employee.toLowerCase()}:${periodId}`;

    if (processedPayouts.has(payoutKey)) {
      logger.info("Payout already processed; returning idempotent success", {
        payoutKey,
      });
      return res.status(200).json({ result: "already_processed", payoutKey });
    }

    // Handle txHash verification
    if (txHash) {
      logger.info("txHash provided; verifying transaction", { txHash });

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return res.status(404).json({ error: "tx-not-found" });
      }

      if (receipt.status !== 1) {
        return res.status(400).json({ error: "tx-failed", txHash });
      }

      processedPayouts.add(payoutKey);
      logger.info("Payout marked processed (via txHash)", {
        payoutKey,
        txHash,
      });
      return res.status(200).json({ result: "ok", txHash });
    }

    // Handle facilitatorProof verification
    if (!facilitatorProof) {
      return res
        .status(400)
        .json({ error: "missing-facilitatorProof-or-txHash" });
    }

    if (!verifiedProofs.has(facilitatorProof)) {
      const sdkOk = await facilitator.verifyProof(facilitatorProof);
      if (!sdkOk) {
        logger.warn("Facilitator SDK rejected proof", {
          proofSnippet: facilitatorProof.slice(0, 20),
        });
      }
      verifiedProofs.add(facilitatorProof);
    }

    // Validate contracts and signer
    if (!paymentVerifierContract) {
      logger.error("PaymentVerifier contract not configured");
      return res.status(500).json({ error: "payment_verifier_not_configured" });
    }
    if (!payrollVaultContract) {
      logger.error("PayrollVault contract not configured");
      return res.status(500).json({ error: "payroll_vault_not_configured" });
    }
    if (!signer) {
      logger.error("On-chain signer not configured (missing PRIVATE_KEY)");
      return res.status(500).json({ error: "server_no_signer" });
    }

    // Call PaymentVerifier.verifyPayment on-chain
    logger.info("Calling PaymentVerifier.verifyPayment on-chain", {
      verifier: PAYMENT_VERIFIER_ADDRESS,
    });

    const proofBytes = ethers.getBytes(facilitatorProof);
    const verifyTx = await paymentVerifierContract.verifyPayment(proofBytes);
    const verifyReceipt = await verifyTx.wait();

    logger.info("PaymentVerifier.verifyPayment tx mined", {
      txHash: verifyReceipt?.hash,
    });

    // Call PayrollVault.releaseSalary
    logger.info("Calling PayrollVault.releaseSalary to release funds", {
      vault: PAYROLL_VAULT_ADDRESS,
      employee,
      periodId,
    });

    const releaseTx = await payrollVaultContract.releaseSalary(
      employee,
      BigInt(periodId)
    );
    const releaseReceipt = await releaseTx.wait();

    processedPayouts.add(payoutKey);

    logger.info("Salary released successfully", {
      payoutKey,
      releaseTxHash: releaseReceipt?.hash,
    });

    return res.status(200).json({
      result: "ok",
      releaseTxHash: releaseReceipt?.hash,
      verifyTxHash: verifyReceipt?.hash,
      payoutKey,
    });
  } catch (err) {
    logger.error("Error in /salary/verify handler", {
      error: (err as Error).message,
      stack: (err as Error).stack,
      body: req.body,
    });
    return res.status(500).json({
      error: "internal_error",
      reason: (err as Error).message,
    });
  }
});

/**
 * POST /simulate-facilitator
 *
 * Demo endpoint for testing - generates a deterministic proof
 */
app.post("/simulate-facilitator", async (req: Request, res: Response) => {
  const { x402 } = req.body;

  if (!x402 || !x402.to || !x402.amount || !x402.periodId) {
    return res.status(400).json({ error: "invalid-x402-payload" });
  }

  try {
    // Generate deterministic proof: employee(20) + periodId(32) + amount(32)
    const employeeBytes = ethers.getBytes(ethers.zeroPadValue(x402.to, 20));
    const periodIdBytes = ethers.toBeHex(BigInt(x402.periodId), 32);
    const amountBytes = ethers.toBeHex(BigInt(x402.amount), 32);

    const proof = ethers.concat([
      employeeBytes,
      ethers.getBytes(periodIdBytes),
      ethers.getBytes(amountBytes),
    ]);

    const proofHex = ethers.hexlify(proof);

    logger.info("Generated simulator proof", {
      employee: x402.to,
      periodId: x402.periodId,
      amount: x402.amount,
      proofLength: proof.length,
    });

    return res.status(200).json({
      success: true,
      proof: proofHex,
      employee: x402.to,
      periodId: x402.periodId,
      amount: x402.amount,
    });
  } catch (err) {
    logger.error("Error in /simulate-facilitator", {
      error: (err as Error).message,
    });
    return res.status(500).json({
      error: "internal_error",
      reason: (err as Error).message,
    });
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
  logger.info(
    `Configured contracts: SalarySchedule=${SALARY_SCHEDULE_ADDRESS} PaymentVerifier=${PAYMENT_VERIFIER_ADDRESS} PayrollVault=${PAYROLL_VAULT_ADDRESS}`
  );
});
