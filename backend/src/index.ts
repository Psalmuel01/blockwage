import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { ethers } from "ethers";
import winston from "winston";
import bodyParser from "body-parser";
import crypto from "crypto";
import axios from "axios";

dotenv.config();

/**
 * BlockWage Backend - Cronos x402 Facilitator Integration
 *
 * This backend integrates with Cronos Labs x402 Facilitator for gasless salary payments.
 *
 * Endpoints:
 *  - GET  /salary/claim/:employeeAddress   -> Returns x402 Payment Required response
 *  - POST /salary/webhook                  -> Receives facilitator payment notifications
 *  - POST /salary/verify                   -> Alternative: Poll-based verification
 *  - POST /admin/deposit                   -> Employer deposits funds
 *  - GET  /admin/employee/:address         -> Get employee details
 *
 * Environment variables:
 *  - RPC_URL                       Cronos RPC endpoint
 *  - PRIVATE_KEY                   Admin wallet private key
 *  - SALARY_SCHEDULE_ADDRESS       SalarySchedule contract
 *  - PAYROLL_VAULT_ADDRESS         PayrollVault contract
 *  - USDC_ADDRESS                  USDC token (EIP-3009 compatible)
 *  - FACILITATOR_URL               Cronos facilitator endpoint
 *  - NETWORK_ID                    CAIP-2 network identifier (eip155:25 for Cronos mainnet)
 *  - WEBHOOK_SECRET                Secret for webhook signature verification
 *  - PORT                          Server port (default 3000)
 */

/* ===========================
   Logging
   =========================== */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
      return `${timestamp} [${level.toUpperCase()}] ${message} ${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

/* ===========================
   Environment Configuration
   =========================== */
const RPC_URL = process.env.RPC_URL || "https://evm-t3.cronos.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const SALARY_SCHEDULE_ADDRESS = process.env.SALARY_SCHEDULE_ADDRESS || "";
const PAYROLL_VAULT_ADDRESS = process.env.PAYROLL_VAULT_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://facilitator-testnet.cronoslabs.org";
const NETWORK_ID = process.env.NETWORK_ID || "eip155:338"; // 338 = Cronos testnet, 25 = mainnet
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me-in-production";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Validation
const requiredEnvVars = {
  PRIVATE_KEY,
  SALARY_SCHEDULE_ADDRESS,
  PAYROLL_VAULT_ADDRESS,
  USDC_ADDRESS,
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    logger.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

/* ===========================
   Contract ABIs
   =========================== */
const SalaryScheduleABI = [
  "function getEmployee(address) view returns (uint256,uint8,uint256,bool)",
  "function nextExpectedPeriod(address) view returns (uint256)",
  "function isDue(address,uint256) view returns (bool,string)",
];

const PayrollVaultABI = [
  "function depositPayroll(uint256,uint256)",
  "function recordPayment(address,uint256,uint256)",
  "function isPaid(address,uint256) view returns (bool)",
  "function periodBalances(uint256) view returns (uint256)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

/* ===========================
   Ethers Setup
   =========================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const salarySchedule = new ethers.Contract(
  SALARY_SCHEDULE_ADDRESS,
  SalaryScheduleABI,
  provider
);

const payrollVault = new ethers.Contract(
  PAYROLL_VAULT_ADDRESS,
  PayrollVaultABI,
  signer
);

const usdcToken = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);

logger.info("Contracts initialized", {
  schedule: SALARY_SCHEDULE_ADDRESS,
  vault: PAYROLL_VAULT_ADDRESS,
  usdc: USDC_ADDRESS,
  network: NETWORK_ID,
  facilitator: FACILITATOR_URL,
});

/* ===========================
   Helper Functions
   =========================== */

/**
 * Verify webhook signature from Cronos Facilitator
 */
function verifyWebhookSignature(
  payload: any,
  signature: string | undefined
): boolean {
  if (!signature) return false;

  const payloadStr = JSON.stringify(payload);
  const expectedSignature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payloadStr)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Format amount for display (assumes 6 decimals for USDC)
 */
function formatAmount(amount: string): string {
  return ethers.formatUnits(amount, 6);
}

/* ===========================
   In-Memory Idempotence Cache
   NOTE: Use Redis/Database for production
   =========================== */
const processedWebhooks = new Set<string>();
const processedPayments = new Map<
  string,
  { txHash: string; timestamp: number }
>();

function getPaymentKey(employee: string, periodId: number | string): string {
  return `${employee.toLowerCase()}:${periodId}`;
}

/* ===========================
   Express App
   =========================== */
const app = express();
app.use(bodyParser.json());

// Request logger
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    params: req.params,
    query: req.query,
  });
  next();
});

/* ===========================
   Core Endpoints
   =========================== */

/**
 * GET /salary/claim/:employeeAddress
 *
 * Returns x402 Payment Required response per Cronos facilitator spec.
 * This endpoint is called by employees or automated schedulers to initiate payment.
 */
app.get(
  "/salary/claim/:employeeAddress",
  async (req: Request, res: Response) => {
    const { employeeAddress } = req.params;

    if (!ethers.isAddress(employeeAddress)) {
      return res.status(400).json({
        error: "invalid-address",
        message: "Employee address is not a valid Ethereum address",
      });
    }

    try {
      // Fetch employee data from SalarySchedule
      const employeeInfo = await salarySchedule.getEmployee(employeeAddress);
      const [salaryBn, cadence, lastPaid, exists] = employeeInfo;

      if (!exists) {
        return res.status(404).json({
          error: "employee-not-found",
          message: "No salary configuration found for this address",
        });
      }

      const salary = salaryBn.toString();
      if (salary === "0") {
        return res.status(404).json({
          error: "no-salary-assigned",
          message: "Salary amount is zero",
        });
      }

      // Get next expected payment period
      const nextPeriodBn = await salarySchedule.nextExpectedPeriod(
        employeeAddress
      );
      const periodId = Number(nextPeriodBn.toString());

      // Check if already paid for this period
      const alreadyPaid = await payrollVault.isPaid(employeeAddress, periodId);
      if (alreadyPaid) {
        return res.status(200).json({
          message: "Salary already paid for this period",
          employee: employeeAddress,
          periodId,
          amount: salary,
          status: "paid",
        });
      }

      // Check if payment is actually due
      const [isDue, reason] = await salarySchedule.isDue(
        employeeAddress,
        periodId
      );

      if (!isDue) {
        return res.status(400).json({
          error: "payment-not-due",
          message: reason || "Payment is not due yet for this period",
          periodId,
          nextPeriod: new Date(periodId * 1000).toISOString(),
        });
      }

      // Check vault has sufficient funds for this period
      const periodBalance = await payrollVault.periodBalances(periodId);
      if (BigInt(periodBalance.toString()) < BigInt(salary)) {
        return res.status(503).json({
          error: "insufficient-funds",
          message:
            "Employer has not deposited sufficient funds for this period",
          required: salary,
          available: periodBalance.toString(),
        });
      }

      // Build x402 Payment Required response per Cronos facilitator spec
      const paymentRequirements = {
        scheme: "exact",
        network: NETWORK_ID,
        maxAmountRequired: salary, // in smallest units (e.g., 1000000 = 1 USDC)
        payTo: PAYROLL_VAULT_ADDRESS, // Vault receives the payment
        asset: USDC_ADDRESS,
        resource: `/salary/claim/${employeeAddress}`,
        description: `BlockWage salary payment - Period ${periodId}`,
        metadata: {
          employee: employeeAddress,
          periodId,
          amount: salary,
          cadence,
          timestamp: Math.floor(Date.now() / 1000),
        },
      };

      logger.info("Payment required response generated", {
        employee: employeeAddress,
        amount: formatAmount(salary),
        periodId,
      });

      // Return 402 Payment Required with x402 spec
      return res.status(402).json({
        error: "Payment Required",
        paymentRequirements,
        facilitatorUrl: FACILITATOR_URL,
        instructions: {
          step1: "Generate EIP-3009 signature using your wallet",
          step2: `POST signature to ${FACILITATOR_URL}/settle`,
          step3:
            "Facilitator will execute gasless transfer and notify this backend",
        },
      });
    } catch (err: any) {
      logger.error("Error in /salary/claim", {
        employee: employeeAddress,
        error: err.message,
        stack: err.stack,
      });
      return res.status(500).json({
        error: "internal-error",
        message: "Failed to process salary claim request",
      });
    }
  }
);

/**
 * POST /salary/webhook
 *
 * Webhook endpoint called by Cronos Facilitator after successful payment settlement.
 * This records the payment on-chain and prevents double-payment.
 */
app.post("/salary/webhook", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-webhook-signature"] as string;
    const webhookId = req.headers["x-webhook-id"] as string;

    // Verify webhook signature
    if (!verifyWebhookSignature(req.body, signature)) {
      logger.warn("Invalid webhook signature", { webhookId });
      return res.status(401).json({ error: "invalid-signature" });
    }

    // Idempotency check
    if (webhookId && processedWebhooks.has(webhookId)) {
      logger.info("Webhook already processed", { webhookId });
      return res.status(200).json({ status: "already-processed" });
    }

    const { event, employee, periodId, amount, txHash, timestamp, metadata } =
      req.body;

    // Validate event type
    if (event !== "payment.completed") {
      logger.warn("Unexpected webhook event type", { event });
      return res.status(400).json({ error: "unexpected-event-type" });
    }

    // Validate required fields
    if (!employee || !periodId || !amount) {
      logger.warn("Missing required webhook fields", req.body);
      return res.status(400).json({ error: "missing-required-fields" });
    }

    logger.info("Facilitator webhook received", {
      employee,
      periodId,
      amount: formatAmount(amount),
      txHash,
      webhookId,
    });

    // Verify employee exists in our system
    const employeeInfo = await salarySchedule.getEmployee(employee);
    if (!employeeInfo[3]) {
      logger.error("Webhook for unknown employee", { employee });
      return res.status(400).json({ error: "employee-not-found" });
    }

    const expectedAmount = employeeInfo[0].toString();
    if (amount !== expectedAmount) {
      logger.error("Amount mismatch", {
        expected: expectedAmount,
        received: amount,
      });
      return res.status(400).json({ error: "amount-mismatch" });
    }

    // Check if already recorded
    const paymentKey = getPaymentKey(employee, periodId);
    const alreadyPaid = await payrollVault.isPaid(employee, periodId);

    if (alreadyPaid) {
      logger.info("Payment already recorded on-chain", { paymentKey });
      if (webhookId) processedWebhooks.add(webhookId);
      return res.status(200).json({ status: "already-recorded" });
    }

    // Record payment on-chain
    logger.info("Recording payment on-chain", { employee, periodId });
    const tx = await payrollVault.recordPayment(employee, periodId, amount);
    const receipt = await tx.wait();

    // Update local cache
    if (webhookId) processedWebhooks.add(webhookId);
    processedPayments.set(paymentKey, {
      txHash: receipt.hash,
      timestamp: Math.floor(Date.now() / 1000),
    });

    logger.info("Payment recorded successfully", {
      employee,
      periodId,
      recordTxHash: receipt.hash,
      facilitatorTxHash: txHash,
    });

    return res.status(200).json({
      status: "success",
      recordTxHash: receipt.hash,
      facilitatorTxHash: txHash,
      employee,
      periodId,
    });
  } catch (err: any) {
    logger.error("Webhook processing error", {
      error: err.message,
      stack: err.stack,
      body: req.body,
    });
    return res.status(500).json({
      error: "internal-error",
      message: "Failed to process webhook",
    });
  }
});

/**
 * POST /salary/verify
 *
 * Alternative verification method: manually verify payment via facilitator API.
 * Use this if webhooks are not available or for manual reconciliation.
 */
app.post("/salary/verify", async (req: Request, res: Response) => {
  const { paymentHeader, employee, periodId } = req.body;

  if (!paymentHeader || !employee || !periodId) {
    return res.status(400).json({
      error: "missing-fields",
      required: ["paymentHeader", "employee", "periodId"],
    });
  }

  try {
    // Get employee info
    const employeeInfo = await salarySchedule.getEmployee(employee);
    if (!employeeInfo[3]) {
      return res.status(404).json({ error: "employee-not-found" });
    }

    const amount = employeeInfo[0].toString();

    // Check if already paid
    const alreadyPaid = await payrollVault.isPaid(employee, periodId);
    if (alreadyPaid) {
      return res.status(200).json({
        status: "already-paid",
        employee,
        periodId,
      });
    }

    // Call Cronos Facilitator verify endpoint
    logger.info("Calling facilitator /verify", { employee, periodId });

    const verifyResponse = await axios.post(`${FACILITATOR_URL}/verify`, {
      x402Version: 1,
      paymentHeader,
      paymentRequirements: {
        scheme: "exact",
        network: NETWORK_ID,
        maxAmountRequired: amount,
        payTo: PAYROLL_VAULT_ADDRESS,
        asset: USDC_ADDRESS,
      },
    });

    if (!verifyResponse.data.verified) {
      logger.warn("Facilitator verification failed", verifyResponse.data);
      return res.status(400).json({
        error: "verification-failed",
        reason: verifyResponse.data.error || "Unknown error",
      });
    }

    // Record payment on-chain
    const tx = await payrollVault.recordPayment(employee, periodId, amount);
    const receipt = await tx.wait();

    logger.info("Payment verified and recorded", {
      employee,
      periodId,
      recordTxHash: receipt.hash,
      settlementTxHash: verifyResponse.data.txHash,
    });

    return res.status(200).json({
      status: "success",
      verified: true,
      recordTxHash: receipt.hash,
      settlementTxHash: verifyResponse.data.txHash,
    });
  } catch (err: any) {
    logger.error("Verification error", {
      error: err.message,
      response: err.response?.data,
    });
    return res.status(500).json({
      error: "internal-error",
      message: err.message,
    });
  }
});

/* ===========================
   Admin Endpoints
   =========================== */

/**
 * POST /admin/deposit
 *
 * Employer deposits funds for a payroll period
 */
app.post("/admin/deposit", async (req: Request, res: Response) => {
  const { periodId, amount } = req.body;

  if (!periodId || !amount) {
    return res.status(400).json({
      error: "missing-fields",
      required: ["periodId", "amount"],
    });
  }

  try {
    const amountBn = ethers.parseUnits(String(amount), 6); // Assuming 6 decimals

    // Check allowance
    const ownerAddress = await signer.getAddress();
    const allowance = await usdcToken.allowance(
      ownerAddress,
      PAYROLL_VAULT_ADDRESS
    );

    if (BigInt(allowance.toString()) < BigInt(amountBn.toString())) {
      logger.info("Approving USDC", { amount: amount.toString() });
      const approveTx = await usdcToken.approve(
        PAYROLL_VAULT_ADDRESS,
        amountBn
      );
      await approveTx.wait();
    }

    // Deposit
    logger.info("Depositing payroll", { periodId, amount: amount.toString() });
    const depositTx = await payrollVault.depositPayroll(periodId, amountBn);
    const receipt = await depositTx.wait();

    logger.info("Deposit successful", {
      periodId,
      amount: amount.toString(),
      txHash: receipt.hash,
    });

    return res.status(200).json({
      status: "success",
      txHash: receipt.hash,
      periodId,
      amount: amount.toString(),
    });
  } catch (err: any) {
    logger.error("Deposit error", { error: err.message });
    return res.status(500).json({
      error: "internal-error",
      message: err.message,
    });
  }
});

/**
 * GET /admin/employee/:address
 *
 * Get employee details and payment status
 */
app.get("/admin/employee/:address", async (req: Request, res: Response) => {
  const { address } = req.params;

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: "invalid-address" });
  }

  try {
    const info = await salarySchedule.getEmployee(address);
    const [salary, cadence, lastPaid, exists] = info;

    if (!exists) {
      return res.status(404).json({ error: "employee-not-found" });
    }

    const nextPeriod = await salarySchedule.nextExpectedPeriod(address);
    const nextPeriodId = Number(nextPeriod.toString());
    const isPaid = await payrollVault.isPaid(address, nextPeriodId);

    const cadenceNames = ["Hourly", "Biweekly", "Monthly"];

    return res.status(200).json({
      employee: address,
      salary: salary.toString(),
      salaryFormatted: formatAmount(salary.toString()),
      cadence: cadenceNames[cadence],
      lastPaid: Number(lastPaid.toString()),
      nextPeriod: nextPeriodId,
      nextPeriodDate: new Date(nextPeriodId * 1000).toISOString(),
      isPaid,
      exists,
    });
  } catch (err: any) {
    logger.error("Error fetching employee", { error: err.message });
    return res.status(500).json({ error: "internal-error" });
  }
});

/**
 * GET /admin/payment-status/:employee/:periodId
 *
 * Check payment status for specific employee and period
 */
app.get(
  "/admin/payment-status/:employee/:periodId",
  async (req: Request, res: Response) => {
    const { employee, periodId } = req.params;

    if (!ethers.isAddress(employee)) {
      return res.status(400).json({ error: "invalid-address" });
    }

    try {
      const isPaid = await payrollVault.isPaid(employee, periodId);
      const paymentKey = getPaymentKey(employee, periodId);
      const localRecord = processedPayments.get(paymentKey);

      return res.status(200).json({
        employee,
        periodId,
        isPaid,
        recordedLocally: !!localRecord,
        localRecord: localRecord || null,
      });
    } catch (err: any) {
      logger.error("Error checking payment status", { error: err.message });
      return res.status(500).json({ error: "internal-error" });
    }
  }
);

/* ===========================
   Health & Info Endpoints
   =========================== */

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
    service: "BlockWage Backend",
    version: "2.0.0-cronos-facilitator",
  });
});

app.get("/info", async (_req: Request, res: Response) => {
  try {
    const blockNumber = await provider.getBlockNumber();
    const network = await provider.getNetwork();

    res.json({
      service: "BlockWage Backend with Cronos x402 Facilitator",
      contracts: {
        salarySchedule: SALARY_SCHEDULE_ADDRESS,
        payrollVault: PAYROLL_VAULT_ADDRESS,
        usdc: USDC_ADDRESS,
      },
      network: {
        chainId: network.chainId.toString(),
        caip2: NETWORK_ID,
        blockNumber,
      },
      facilitator: FACILITATOR_URL,
      features: [
        "x402 Payment Required responses",
        "Cronos Facilitator integration",
        "EIP-3009 gasless payments",
        "Webhook support",
        "Manual verification fallback",
      ],
    });
  } catch (err: any) {
    logger.error("Error in /info", { error: err.message });
    res.status(500).json({ error: "internal-error" });
  }
});

/* ===========================
   Error Handler
   =========================== */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({
    error: "internal-server-error",
    message: "An unexpected error occurred",
  });
});

/* ===========================
   Start Server
   =========================== */
app.listen(PORT, () => {
  logger.info(`🚀 BlockWage Backend started on port ${PORT}`);
  logger.info(`📡 Network: ${NETWORK_ID}`);
  logger.info(`🏦 Facilitator: ${FACILITATOR_URL}`);
  logger.info(`📋 Contracts:`);
  logger.info(`   - SalarySchedule: ${SALARY_SCHEDULE_ADDRESS}`);
  logger.info(`   - PayrollVault: ${PAYROLL_VAULT_ADDRESS}`);
  logger.info(`   - USDC: ${USDC_ADDRESS}`);
  logger.info(
    `✅ Ready to process salary payments via Cronos x402 Facilitator`
  );
});
