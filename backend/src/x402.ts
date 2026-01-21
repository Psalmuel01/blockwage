/**
 * Vibe Coding/blockwage/backend/src/x402.ts
 *
 * Helpers for the x402 payment flow:
 *  - generateX402Response: construct a 402 Payment Required (x402) response body
 *  - parseFacilitatorProof: parse a raw facilitator proof (hex/base64/bytes) into structured fields
 *  - buildFacilitatorProofHex: helper to build a raw facilitator-proof hex for tests (employee|periodId|amount)
 *
 * Proof encoding (convention used by this project):
 *   abi.encodePacked(
 *     employeeAddress (20 bytes) |
 *     periodId (32 bytes, big-endian uint256) |
 *     amount (32 bytes, big-endian uint256) |
 *     optional extra bytes...
 *   )
 *
 * Notes:
 *  - This module is intentionally conservative and portable: it uses Buffer to parse binary input,
 *    and returns BigInt for numeric fields so callers can decide how to treat them.
 *  - In production the facilitator proof should contain cryptographic attestations (signatures/MACs)
 *    or be verifiable against the facilitator backend. Here we only provide structural helpers.
 */

import { getAddress } from "ethers";

// Types exported by this module
export type X402Body = {
  to: string; // employee address (checksum)
  amount: string; // decimal string representing smallest-unit amount (e.g., USDC has 6 decimals)
  token: string; // token contract address (stablecoin)
  periodId: string | number; // period identifier (opaque to x402; often unix-aligned timestamp or custom id)
  currency?: string; // optional human-friendly currency label
  metadata?: Record<string, any>; // optional extra metadata
};

export type ParsedFacilitatorProof = {
  rawHex: string; // normalized 0x hex string of the provided proof
  employee: string; // checksum address string
  periodId: bigint; // numeric period id
  amount: bigint; // numeric amount (in token smallest unit)
  extra?: Uint8Array; // remaining bytes, if any
};

/**
 * Generate an x402-style response body that can be returned with HTTP 402.
 *
 * Parameters are intentionally permissive (accept numbers/strings).
 */
export function generateX402Response(
  to: string,
  amount: string | number | bigint,
  token: string,
  periodId: string | number | bigint,
  opts?: { currency?: string; metadata?: Record<string, any> }
): X402Body {
  // Normalize address if possible; if invalid, return as-provided (caller should have validated)
  let checksum = to;
  try {
    checksum = getAddress(to);
  } catch {
    // fallthrough: keep original value if not a checksummed address
  }

  // Normalize amount/periodId to strings for JSON-friendly response
  const amountStr = typeof amount === "bigint" ? amount.toString() : String(amount);
  const periodStr = typeof periodId === "bigint" ? periodId.toString() : String(periodId);

  return {
    to: checksum,
    amount: amountStr,
    token,
    periodId: periodStr,
    currency: opts?.currency,
    metadata: opts?.metadata,
  };
}

/**
 * Parse a facilitator proof provided as:
 *  - 0x-prefixed hex string
 *  - base64 string (no 0x)
 *  - Uint8Array / Buffer
 *
 * Expected layout (this project's convention):
 *   bytes 0..19   => employee address (20 bytes)
 *   bytes 20..51  => periodId (32 bytes, big-endian)
 *   bytes 52..83  => amount (32 bytes, big-endian)
 *   bytes 84..end  => optional extra
 *
 * Returns a ParsedFacilitatorProof with BigInt numeric fields.
 *
 * Throws Error on malformed input or if proof is too short.
 */
export function parseFacilitatorProof(input: string | Uint8Array | Buffer): ParsedFacilitatorProof {
  const buf = normalizeToBuffer(input);

  // minimum required length: 20 + 32 + 32 = 84
  if (buf.length < 84) {
    throw new Error(`facilitatorProof-too-short (got ${buf.length} bytes, need >= 84)`);
  }

  const employeeBuf = buf.slice(0, 20); // 20 bytes
  const periodBuf = buf.slice(20, 52); // 32 bytes
  const amountBuf = buf.slice(52, 84); // 32 bytes
  const extraBuf = buf.slice(84);

  // Convert employee to checksummed address
  const employeeHex = "0x" + employeeBuf.toString("hex");
  let employeeAddr: string;
  try {
    employeeAddr = getAddress(employeeHex);
  } catch (err) {
    // If getAddress fails, still return the lowercased hex form to avoid losing data
    employeeAddr = employeeHex;
  }

  const periodId = bufferToBigInt(periodBuf);
  const amount = bufferToBigInt(amountBuf);

  const rawHex = "0x" + buf.toString("hex");

  return {
    rawHex,
    employee: employeeAddr,
    periodId,
    amount,
    extra: extraBuf.length > 0 ? new Uint8Array(extraBuf) : undefined,
  };
}

/**
 * Build a facilitator-proof hex suitable for tests or local scheduler simulation.
 * Encodes employee (20 bytes), periodId (32 bytes BE), amount (32 bytes BE).
 *
 * Returns '0x' prefixed hex string.
 */
export function buildFacilitatorProofHex(employee: string, periodId: bigint | number, amount: bigint | number): string {
  // Normalize employee address to 20 bytes
  let employeeClean = employee;
  try {
    employeeClean = getAddress(employee);
  } catch {
    // allow raw hex input like 0xabcdef... (must be 20 bytes)
    if (typeof employee === "string" && /^0x[0-9a-fA-F]{40}$/.test(employee)) {
      employeeClean = employee;
    } else {
      throw new Error("invalid-employee-address");
    }
  }

  const employeeBuf = Buffer.from(employeeClean.slice(2), "hex");
  if (employeeBuf.length !== 20) {
    throw new Error("employee-address-not-20-bytes");
  }

  const periodBuf = bigIntToBuffer(BigInt(periodId), 32);
  const amountBuf = bigIntToBuffer(BigInt(amount), 32);

  const combined = Buffer.concat([employeeBuf, periodBuf, amountBuf]);
  return "0x" + combined.toString("hex");
}

/* ===========================
   Helper utilities
   =========================== */

/**
 * Normalize input (hex/base64/bytes) to Buffer.
 */
function normalizeToBuffer(input: string | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (typeof input === "string") {
    if (input.startsWith("0x") || input.startsWith("0X")) {
      const hex = input.slice(2);
      if (hex.length % 2 !== 0) {
        throw new Error("invalid-hex-length");
      }
      return Buffer.from(hex, "hex");
    }
    // treat as base64
    try {
      return Buffer.from(input, "base64");
    } catch {
      throw new Error("input-not-hex-or-base64-or-bytes");
    }
  }
  throw new Error("unsupported-facilitatorProof-type");
}

/**
 * Convert a Buffer (big-endian unsigned) to BigInt.
 */
function bufferToBigInt(buf: Buffer): bigint {
  let hex = buf.toString("hex");
  if (hex === "") return BigInt(0);
  return BigInt("0x" + hex);
}

/**
 * Convert BigInt to Buffer of fixed length (big-endian).
 */
function bigIntToBuffer(value: bigint, length: number): Buffer {
  if (value < 0n) {
    throw new Error("bigint-must-be-non-negative");
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length > length) {
    throw new Error("bigint-too-large-for-fixed-length");
  }
  if (bytes.length === length) {
    return bytes;
  }
  // left-pad with zeros
  const padded = Buffer.alloc(length);
  bytes.copy(padded, length - bytes.length);
  return padded;
}
