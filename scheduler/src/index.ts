/**
 *
 * Scheduler service that:
 *  - Listens to `SalaryDue` events from the SalarySchedule contract on Cronos (x402 flow trigger)
 *  - Calls employee HTTP endpoints to obtain x402 402 Payment Required responses
 *  - Uses the facilitator flow (or local stub) to produce a facilitator-proof
 *  - Posts the facilitator proof to the payroll backend (/salary/verify) to finalize release
 *  - Implements retries, exponential backoff, idempotence, logging and graceful shutdown
 *
 * Configuration (env):
 *  - RPC_URL                      Cronos RPC (e.g. https://evm-t3.cronos.org)
 *  - SALARY_SCHEDULE_ADDRESS      Deployed SalarySchedule contract to listen to
 *  - EMPLOYEE_CLAIM_BASE_URL      Base URL for employee claim endpoints (e.g. https://employee-host)
 *                                 If left empty defaults to BlockWage backend `BACKEND_URL`
 *  - BACKEND_URL                  BlockWage backend base URL (used for /salary/verify)
 *  - PRIVATE_KEY                  Optional admin key used by facilitator (not required for stubs)
 *  - SCHED_CRON                   Cron expression for periodic rescan (optional)
 *  - MAX_RETRIES                  Number of retries for HTTP calls (default 5)
 *  - RETRY_BASE_MS                Base backoff in ms (default 1000)
 *  - LOG_LEVEL                    Logging level
 *
 * NOTE:
 *  - This scheduler is intentionally conservative and extensible. Replace the facilitator wrapper
 *    with the real `@crypto.com/facilitator-client` usage when integrating with the production SDK.
 */

import dotenv from "dotenv";
import { ethers } from "ethers";
import axios from "axios";
import winston from "winston";
import fs from "fs";
import path from "path";
import { CronJob } from "cron";

dotenv.config();

/* =========================
   Configuration
   ========================= */
const RPC_URL = process.env.RPC_URL || "https://evm-t3.cronos.org";
const SALARY_SCHEDULE_ADDRESS = process.env.SALARY_SCHEDULE_ADDRESS || "";
const EMPLOYEE_CLAIM_BASE_URL = process.env.EMPLOYEE_CLAIM_BASE_URL || process.env.BACKEND_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const SCHED_CRON = process.env.SCHED_CRON || "0 */1 * * * *"; // every minute by default for demo
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "5", 10);
const RETRY_BASE_MS = parseInt(process.env.RETRY_BASE_MS || "1000", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const PERSISTENCE_DIR = process.env.PERSISTENCE_DIR || path.join(process.cwd(), "data");
const PROCESSED_FILE = path.join(PERSISTENCE_DIR, "processed.json");

/* =========================
   Logger
   ========================= */
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

/* =========================
   Ethers & Contract setup
   ========================= */
// Minimal ABI for SalarySchedule SalaryDue event
const SalaryScheduleABI = [
  "event SalaryDue(address indexed employee, uint256 amount, address token, uint256 periodId)",
  "function nextExpectedPeriod(address) view returns (uint256)",
  "function getEmployee(address) view returns (uint256,uint8,uint256,bool)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
let wallet: ethers.Wallet | undefined;
if (PRIVATE_KEY) {
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
} else {
  wallet = undefined;
}

if (!SALARY_SCHEDULE_ADDRESS) {
  logger.error("SALARY_SCHEDULE_ADDRESS is not set. Exiting.");
  process.exit(1);
}

const salaryScheduleContract = new ethers.Contract(SALARY_SCHEDULE_ADDRESS, SalaryScheduleABI, provider);

/* =========================
   Persistence / Idempotence
   ========================= */
if (!fs.existsSync(PERSISTENCE_DIR)) {
  try {
    fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
  } catch (err) {
    logger.warn("Failed to create persistence dir, continuing in-memory only", { err: (err as Error).message });
  }
}

// processedSet stores keys of form `${employee.toLowerCase()}:${periodId}`
let processedSet = new Set<string>();

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = fs.readFileSync(PROCESSED_FILE, "utf8");
      const arr = JSON.parse(data) as string[];
      processedSet = new Set(arr);
      logger.info("Loaded processed payouts from persistence", { count: processedSet.size });
    }
  } catch (err) {
    logger.warn("Failed to load processed file; starting empty", { err: (err as Error).message });
    processedSet = new Set();
  }
}

function persistProcessed() {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(Array.from(processedSet), null, 2));
    logger.debug("Persisted processed payouts", { count: processedSet.size });
  } catch (err) {
    logger.error("Failed to persist processed payouts", { err: (err as Error).message });
  }
}

/* =========================
   Facilitator Client Wrapper (attempt to use SDK; fallback to stub)
   ========================= */
class FacilitatorWrapper {
  private client: any = null;
  public available = false;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require("@crypto.com/facilitator-client");
      // Adapt depending on SDK shape. For now, store sdk object and mark available.
      this.client = sdk;
      this.available = true;
      logger.info("Facilitator SDK loaded");
    } catch (err) {
      this.client = null;
      this.available = false;
      logger.warn("Facilitator SDK not available - using local stub", { reason: (err as Error).message });
    }
  }

  /**
   * createPayment
   * - For real SDK: build facilitator payment and submit
   * - For stub: return a compact proof (0x hex) encoding employee (20 bytes) | periodId (32) | amount (32)
   */
  async createPayment(opts: { to: string; amount: bigint; token: string; periodId: bigint }): Promise<{ proofHex: string; meta?: any }> {
    if (this.available && this.client) {
      try {
        // Example placeholder: actual SDK call will differ
        if (typeof this.client.createPayment === "function") {
          const result = await this.client.createPayment(opts);
          // Expect the SDK to return some proof or reference. Normalize to proofHex.
          return { proofHex: result.proofHex || result.proof || "", meta: result };
        } else {
          // If SDK shape unknown, fallback to stub
          logger.warn("Facilitator SDK present but createPayment not found; using local stub");
        }
      } catch (err) {
        logger.error("Facilitator SDK createPayment failed; falling back to stub", { err: (err as Error).message });
      }
    }

    // Stub: build proof by abi packing address|periodId|amount (raw bytes -> 0xhex)
    const proofHex = buildFacilitatorProofHex(opts.to, opts.periodId, opts.amount);
    return { proofHex, meta: { stub: true } };
  }

  // Optional verify helper via SDK
  async verifyProof(proofHex: string): Promise<boolean> {
    if (this.available && this.client && typeof this.client.verifyProof === "function") {
      try {
        return await this.client.verifyProof(proofHex);
      } catch (err) {
        logger.warn("Facilitator SDK verifyProof failed", { err: (err as Error).message });
        return false;
      }
    }
    // Stub: accept proofs locally
    return Boolean(proofHex && proofHex.startsWith("0x"));
  }
}

function buildFacilitatorProofHex(employee: string, periodId: bigint, amount: bigint): string {
  // employee: 0x... 20 bytes
  const emp = ethers.getAddress(employee);
  const empBuf = Buffer.from(emp.slice(2), "hex"); // 20 bytes
  const periodBuf = bigIntToBuffer(periodId, 32);
  const amountBuf = bigIntToBuffer(amount, 32);
  const combined = Buffer.concat([empBuf, periodBuf, amountBuf]);
  return "0x" + combined.toString("hex");
}

function bigIntToBuffer(value: bigint, length: number): Buffer {
  if (value < 0n) throw new Error("bigint-must-be-non-negative");
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length > length) throw new Error("bigint-too-large");
  const buf = Buffer.alloc(length);
  bytes.copy(buf, length - bytes.length);
  return buf;
}

/* =========================
   HTTP Helpers
   ========================= */
async function httpGetWithRetries(url: string, maxRetries = MAX_RETRIES): Promise<axios.AxiosResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await axios.get(url, { validateStatus: () => true, timeout: 15_000 });
      return resp;
    } catch (err) {
      const wait = RETRY_BASE_MS * 2 ** attempt;
      logger.warn("GET attempt failed, retrying", { url, attempt, wait, err: (err as Error).message });
      await sleep(wait);
    }
  }
  throw new Error(`GET failed after ${maxRetries} attempts: ${url}`);
}

async function httpPostWithRetries(url: string, body: any, maxRetries = MAX_RETRIES): Promise<axios.AxiosResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await axios.post(url, body, { timeout: 30_000, validateStatus: () => true });
      return resp;
    } catch (err) {
      const wait = RETRY_BASE_MS * 2 ** attempt;
      logger.warn("POST attempt failed, retrying", { url, attempt, wait, err: (err as Error).message });
      await sleep(wait);
    }
  }
  throw new Error(`POST failed after ${maxRetries} attempts: ${url}`);
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/* =========================
   Event Handling
   ========================= */
const facilitator = new FacilitatorWrapper();

async function handleSalaryDueEvent(employee: string, amount: ethers.BigNumber, token: string, periodId: ethers.BigNumber) {
  const empLower = employee.toLowerCase();
  const pid = BigInt(periodId.toString());
  const amt = BigInt(amount.toString());
  const key = `${empLower}:${pid}`;

  logger.info("SalaryDue event received", { employee, amount: amt.toString(), token, periodId: pid.toString(), key });

  if (processedSet.has(key)) {
    logger.info("Payout already processed (local cache) - skipping", { key });
    return;
  }

  // Step 1: call employee claim endpoint (x402 style)
  const claimUrl = `${EMPLOYEE_CLAIM_BASE_URL.replace(/\/$/, "")}/salary/claim/${employee}`;
  logger.info("Calling employee claim endpoint", { claimUrl });

  let resp;
  try {
    resp = await httpGetWithRetries(claimUrl);
  } catch (err) {
    logger.error("Failed to call employee claim endpoint", { claimUrl, err: (err as Error).message });
    await alertFailure(`Failed to call claim endpoint for ${employee}`, { employee, periodId: pid.toString() });
    return;
  }

  // Expect 402 Payment Required with x402 info in body
  if (resp.status !== 402) {
    logger.warn("Claim endpoint did not respond with 402 Payment Required", { status: resp.status, body: resp.data });
    // Might mean nothing due or the employee has no HTTP endpoint; do not proceed
    return;
  }

  const x402 = resp.data?.x402 || resp.data;
  if (!x402 || !x402.to || !x402.amount || !x402.periodId) {
    logger.error("Malformed x402 response from claim endpoint", { body: resp.data });
    await alertFailure("Malformed x402 response", { employee, resp: resp.data });
    return;
  }

  // Normalize values
  const to = x402.to;
  const amountStr = String(x402.amount);
  const periodIdFromX402 = BigInt(String(x402.periodId));

  // Step 2: use facilitator to create payment / proof
  let proofHex: string | undefined;
  try {
    const { proofHex: phex, meta } = await facilitator.createPayment({ to, amount: BigInt(amountStr), token: x402.token || token, periodId: periodIdFromX402 });
    proofHex = phex;
    logger.info("Facilitator produced proof", { proofHex: proofHex?.slice(0, 66) + (proofHex && proofHex.length > 66 ? "..." : ""), meta });
  } catch (err) {
    logger.error("Facilitator createPayment failed", { err: (err as Error).message });
    await alertFailure("Facilitator failure", { employee, periodId: pid.toString(), err: (err as Error).message });
    return;
  }

  if (!proofHex) {
    logger.error("No proof produced by facilitator - aborting");
    await alertFailure("Empty facilitator proof", { employee, periodId: pid.toString() });
    return;
  }

  // Step 3: call payroll backend to verify & trigger on-chain release
  const verifyUrl = `${BACKEND_URL.replace(/\/$/, "")}/salary/verify`;
  const payload = { facilitatorProof: proofHex, employee: to, periodId: Number(periodIdFromX402) };
  logger.info("Posting facilitator proof to backend for verification", { verifyUrl, payloadSnippet: { employee: to, periodId: payload.periodId } });

  let verifyResp;
  try {
    verifyResp = await httpPostWithRetries(verifyUrl, payload);
  } catch (err) {
    logger.error("Posting proof to backend failed", { err: (err as Error).message });
    await alertFailure("Backend verify failed", { employee: to, periodId: pid.toString() });
    return;
  }

  if (verifyResp.status !== 200) {
    logger.error("Backend verification failed / returned non-200", { status: verifyResp.status, body: verifyResp.data });
    // do not mark processed; allow retries later
    await alertFailure("Backend verification rejected", { employee: to, backendResponse: verifyResp.data });
    return;
  }

  // Success path
  logger.info("Payout flow completed successfully", { employee: to, periodId: pid.toString(), proofPreview: proofHex.slice(0, 66) });
  processedSet.add(key);
  persistProcessed();
}

/* =========================
   Alerts (pluggable)
   ========================= */
async function alertFailure(title: string, ctx: Record<string, any>) {
  // For demo: log. Integrate with Slack/email in production via env webhooks.
  logger.error("ALERT: " + title, ctx);
  // Optionally call a webhook (e.g., Slack) if configured via env var - left as op to implement.
}

/* =========================
   Cron rescan job
   ========================= */
async function rescanRecentSalaryDueWindow() {
  // Strategy: scan the last N blocks/time window for SalaryDue events and process any missed ones.
  // For demo we scan events from block range of last ~60 minutes
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowSecs = 60 * 60; // 1 hour
    // We don't have a deterministic mapping from time->block cheaply without provider support; we'll fallback to
    // using provider.getBlockNumber and scanning last N blocks.
    const latestBlock = await provider.getBlockNumber();
    const blocksToScan = 1200; // arbitrary - depends on network TPS; keep conservative
    const fromBlock = Math.max(0, latestBlock - blocksToScan);
    logger.info("Rescanning SalaryDue events window", { latestBlock, fromBlock, toBlock: latestBlock });

    const filter = salaryScheduleContract.filters.SalaryDue();
    const events = await salaryScheduleContract.queryFilter(filter, fromBlock, latestBlock);
    logger.info("Found events during rescan", { count: events.length });

    for (const ev of events) {
      try {
        const employee = ev.args?.[0] as string;
        const amount = ev.args?.[1] as ethers.BigNumber;
        const token = ev.args?.[2] as string;
        const periodId = ev.args?.[3] as ethers.BigNumber;
        await handleSalaryDueEvent(employee, amount, token, periodId);
      } catch (err) {
        logger.warn("Error processing event in rescan", { err: (err as Error).message });
      }
    }
  } catch (err) {
    logger.error("Rescan failed", { err: (err as Error).message });
  }
}

/* =========================
   Wiring: subscribe to events & start cron
   ========================= */
function subscribeToSalaryDue() {
  logger.info("Subscribing to SalaryDue events", { contract: SALARY_SCHEDULE_ADDRESS });

  const handler = async (employee: string, amount: ethers.BigNumber, token: string, periodId: ethers.BigNumber, event: any) => {
    try {
      await handleSalaryDueEvent(employee, amount, token, periodId);
    } catch (err) {
      logger.error("Unhandled error in SalaryDue handler", { err: (err as Error).message });
    }
  };

  salaryScheduleContract.on("SalaryDue", handler);

  // graceful unsubscription on shutdown
  process.on("SIGINT", async () => {
    logger.info("SIGINT received - unsubscribing and exiting");
    salaryScheduleContract.off("SalaryDue", handler);
    persistProcessed();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received - unsubscribing and exiting");
    salaryScheduleContract.off("SalaryDue", handler);
    persistProcessed();
    process.exit(0);
  });

  logger.info("Subscribed to SalaryDue events");
}

function startCronRescan() {
  try {
    const job = new CronJob(
      SCHED_CRON,
      async () => {
        logger.info("Cron rescan triggered", { SCHED_CRON });
        await rescanRecentSalaryDueWindow();
      },
      null,
      true,
      "UTC"
    );
    job.start();
    logger.info("Cron rescan scheduled", { expression: SCHED_CRON });
  } catch (err) {
    logger.warn("Failed to start cron rescan", { err: (err as Error).message });
  }
}

/* =========================
   Initialization
   ========================= */
async function init() {
  logger.info("Starting BlockWage scheduler", {
    rpc: RPC_URL,
    salarySchedule: SALARY_SCHEDULE_ADDRESS,
    employeeClaimBase: EMPLOYEE_CLAIM_BASE_URL,
    backend: BACKEND_URL,
  });

  loadProcessed();

  // Subscribe to on-chain SalaryDue events
  try {
    subscribeToSalaryDue();
  } catch (err) {
    logger.error("Failed to subscribe to events", { err: (err as Error).message });
    process.exit(1);
  }

  // Start periodic rescan to catch missed events
  startCronRescan();

  logger.info("Scheduler started and operational");
}

init().catch((err) => {
  logger.error("Scheduler initialization failed", { err: (err as Error).message });
  process.exit(1);
});
