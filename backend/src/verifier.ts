/**
 * Vibe Coding/blockwage/backend/src/verifier.ts
 *
 * Verifier stub for local testing / development:
 * - Simulates facilitator / PaymentVerifier logic.
 * - Intended to be used by the backend HTTP server to perform local structural checks
 *   and simple replay/double-pay protection before calling on-chain verifier.
 *
 * Exported:
 *  - class Verifier
 *      - async verify(parsedProofOrHex): Promise<boolean>
 *      - isProofSeen(proofHex): boolean
 *      - isPayoutProcessed(employee, periodId): boolean
 *      - reset() // resets in-memory state - useful for tests
 *
 * Notes:
 *  - This is intentionally a local, in-memory stub. It performs structural validation
 *    and basic replay protection only. It does NOT replace the on-chain PaymentVerifier
 *    or an authoritative facilitator backend verification in production.
 */

import { ParsedFacilitatorProof } from "./x402";

/**
 * Minimal shape accepted by Verifier.verify
 */
export type VerifierInput =
  | ParsedFacilitatorProof
  | {
      rawHex: string;
      employee?: string;
      periodId?: bigint | number;
      amount?: bigint | number;
    }
  | string;

export class Verifier {
  // Set of raw proof hex strings that have been seen/verified locally
  private proofSeen: Set<string>;
  // Map of processed payouts to prevent double processing keyed by `${employee.toLowerCase()}:${periodId}`
  private processedPayouts: Set<string>;

  constructor() {
    this.proofSeen = new Set();
    this.processedPayouts = new Set();
  }

  /**
   * verify
   *
   * Accepts:
   *  - ParsedFacilitatorProof (preferred)
   *  - Or an object containing rawHex and optionally employee/periodId/amount
   *  - Or a raw hex string (0x...)
   *
   * Behavior:
   *  - Performs structural checks (employee non-zero, periodId > 0, amount > 0)
   *  - Returns false if proof was already seen OR if (employee,periodId) is already processed
   *  - Marks proof as seen and (optionally) marks payout processed only if `markProcessed` option is true.
   *    For compatibility with the rest of the backend, this function will NOT automatically mark a payout
   *    processed; the backend should mark a payout processed only after on-chain release is confirmed.
   *
   * For tests & local flows the caller typically expects `true` when proof looks valid.
   */
  async verify(
    input: VerifierInput,
    opts?: { markProcessed?: boolean }
  ): Promise<boolean> {
    // Normalize input to an object with rawHex, employee, periodId, amount
    const normalized = this.normalizeInput(input);
    if (!normalized) return false;

    const { rawHex, employee, periodId, amount } = normalized;

    // Basic checks
    if (!rawHex || typeof rawHex !== "string") {
      return false;
    }
    if (
      !employee ||
      typeof employee !== "string" ||
      employee === "0x0000000000000000000000000000000000000000"
    ) {
      return false;
    }
    if (!periodId || BigInt(periodId) === 0n) {
      return false;
    }
    if (!amount || BigInt(amount) === 0n) {
      return false;
    }

    // Replay protection: has this exact raw proof been seen previously?
    if (this.proofSeen.has(rawHex)) {
      // seen before -> reject to avoid double consumption of the exact same proof locally
      return false;
    }

    // Double-pay protection: ensure (employee, periodId) not already processed
    const payoutKey = this.keyFor(employee, periodId);
    if (this.processedPayouts.has(payoutKey)) {
      // Already processed payout for this employee+period
      return false;
    }

    // Mark proof seen
    this.proofSeen.add(rawHex);

    // Optionally mark payout processed immediately (usually the caller will wait for on-chain confirmation)
    if (opts && opts.markProcessed) {
      this.processedPayouts.add(payoutKey);
    }

    // Simulate async work (e.g., contacting facilitator SDK) without actually calling external services.
    // In real integration we'd call @crypto.com/facilitator-client here to verify signatures/receipts.
    await this.simulatedDelay(50);

    return true;
  }

  /**
   * Helper that returns whether a raw proof hex has been seen locally
   */
  isProofSeen(rawHex: string): boolean {
    return this.proofSeen.has(rawHex);
  }

  /**
   * Whether a payout (employee + periodId) has been processed locally
   */
  isPayoutProcessed(
    employee: string,
    periodId: bigint | number | string
  ): boolean {
    return this.processedPayouts.has(this.keyFor(employee, periodId));
  }

  /**
   * Mark a payout as processed (used after on-chain success)
   */
  markPayoutProcessed(employee: string, periodId: bigint | number | string) {
    this.processedPayouts.add(this.keyFor(employee, periodId));
  }

  /**
   * Reset internal state - useful for unit tests
   */
  reset() {
    this.proofSeen.clear();
    this.processedPayouts.clear();
  }

  /* ============================
     Internal helpers
     ============================ */

  private keyFor(employee: string, periodId: bigint | number | string) {
    const emp = employee.toLowerCase();
    const pid =
      typeof periodId === "bigint" ? periodId.toString() : String(periodId);
    return `${emp}:${pid}`;
  }

  private normalizeInput(
    input: VerifierInput
  ): {
    rawHex: string;
    employee: string;
    periodId: bigint;
    amount: bigint;
  } | null {
    // If input is a string, treat it as rawHex
    if (typeof input === "string") {
      const rawHex = input;
      // We cannot deduce employee/period/amount from raw hex without parsing; return basic shape only if possible.
      // Attempt to parse the same layout used by x402 helpers: employee (20) + periodId (32) + amount (32)
      try {
        const buf = this.hexToBuffer(rawHex);
        if (buf.length < 84) return null;
        const employeeBuf = buf.slice(0, 20);
        const periodBuf = buf.slice(20, 52);
        const amountBuf = buf.slice(52, 84);
        const employee = "0x" + employeeBuf.toString("hex");
        const periodId = this.bufferToBigInt(periodBuf);
        const amount = this.bufferToBigInt(amountBuf);
        return { rawHex, employee, periodId, amount };
      } catch {
        return null;
      }
    }

    // If input appears to be a ParsedFacilitatorProof
    const maybe = input as ParsedFacilitatorProof | any;
    if (
      maybe &&
      typeof maybe.rawHex === "string" &&
      maybe.employee &&
      maybe.periodId !== undefined &&
      maybe.amount !== undefined
    ) {
      const rawHex = maybe.rawHex;
      const employee = String(maybe.employee);
      const periodId = BigInt(maybe.periodId);
      const amount = BigInt(maybe.amount);
      return { rawHex, employee, periodId, amount };
    }

    // If input is an object with rawHex and optional fields
    if (maybe && typeof maybe.rawHex === "string") {
      const rawHex = maybe.rawHex;
      const employee = maybe.employee
        ? String(maybe.employee)
        : "0x0000000000000000000000000000000000000000";
      const periodId =
        maybe.periodId !== undefined ? BigInt(maybe.periodId) : 0n;
      const amount = maybe.amount !== undefined ? BigInt(maybe.amount) : 0n;
      return { rawHex, employee, periodId, amount };
    }

    return null;
  }

  private hexToBuffer(hex: string): Buffer {
    if (hex.startsWith("0x") || hex.startsWith("0X")) {
      const cleaned = hex.slice(2);
      return Buffer.from(cleaned, "hex");
    }
    // try base64 -> not expected here
    return Buffer.from(hex, "base64");
  }

  private bufferToBigInt(buf: Buffer): bigint {
    if (buf.length === 0) return 0n;
    return BigInt("0x" + buf.toString("hex"));
  }

  private simulatedDelay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
}

export default Verifier;
