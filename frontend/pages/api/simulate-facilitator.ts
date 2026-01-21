import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { ethers } from "ethers";

/**
 * API: /api/simulate-facilitator
 *
 * POST:
 *  - Accepts JSON body containing either:
 *      { x402: { to, amount, token, periodId, ... } }
 *    or
 *      { to, amount, token, periodId }
 *
 *  - If a BACKEND URL is configured (NEXT_PUBLIC_BACKEND_URL or BACKEND_URL),
 *    this route will attempt to proxy the request to `${BACKEND_URL}/simulate-facilitator`.
 *    If that call fails or the env var is not set, it will fall back to a local simulator
 *    that returns a deterministic mock `proof` (0x-prefixed hex).
 *
 * GET:
 *  - Health check. If BACKEND_URL is set, proxied to `${BACKEND_URL}/health`. Otherwise returns local OK.
 *
 * Response (POST local simulated):
 *  {
 *    proof: "0x...",
 *    proofHash: "0x...",
 *    meta: { simulated: true, generatedAt: 167..., x402: {...} }
 *  }
 */

/* Helper: build facilitator proof as abi-packed bytes:
   proof = abi.encodePacked(employeeAddress(20 bytes) | periodId (32 bytes BE) | amount (32 bytes BE))
   returned as 0xHEX
*/
function addrTo20Bytes(addr: string): Buffer {
  if (!addr) throw new Error("missing address");
  // Ensure checksummed/normalized
  const normalized = ethers.getAddress(addr);
  const hex = normalized.slice(2); // without 0x
  return Buffer.from(hex.padStart(40, "0"), "hex");
}

function bigIntTo32BE(value: bigint): Buffer {
  if (value < 0n) throw new Error("negative bigint not supported");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  const buf = Buffer.from(hex, "hex");
  if (buf.length > 32) {
    throw new Error("bigint too large to fit 32 bytes");
  }
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}

function normalizeToBigInt(v: any): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    // if hex
    if (v.startsWith("0x") || v.startsWith("0X")) return BigInt(v);
    // decimal string
    if (/^\d+$/.test(v)) return BigInt(v);
    // try parse float-like -> not supported
    throw new Error("invalid numeric string for bigint");
  }
  throw new Error("unsupported numeric type");
}

function buildProofHex(to: string, periodId: bigint | number | string, amount: bigint | number | string) {
  const empBuf = addrTo20Bytes(to);
  const pid = normalizeToBigInt(periodId);
  const amt = normalizeToBigInt(amount);
  const pidBuf = bigIntTo32BE(pid);
  const amtBuf = bigIntTo32BE(amt);
  const combined = Buffer.concat([empBuf, pidBuf, amtBuf]);
  return "0x" + combined.toString("hex");
}

async function proxyPost(backendUrl: string, body: any) {
  const url = backendUrl.replace(/\/$/, "") + "/simulate-facilitator";
  // forward request
  return axios.post(url, body, {
    headers: {
      "content-type": "application/json",
    },
    timeout: 10_000,
  });
}

async function proxyGetHealth(backendUrl: string) {
  const url = backendUrl.replace(/\/$/, "") + "/health";
  return axios.get(url, { timeout: 5000 });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const BACKEND =
    process.env.NEXT_PUBLIC_BACKEND_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    "";

  if (req.method === "GET") {
    // health endpoint - proxy if backend available
    if (BACKEND) {
      try {
        const r = await proxyGetHealth(BACKEND);
        return res.status(r.status).json({ proxied: true, data: r.data });
      } catch (err: any) {
        return res.status(200).json({
          ok: true,
          source: "local",
          note: "backend health proxy failed",
          error: err?.message || String(err),
        });
      }
    }
    return res.status(200).json({ ok: true, source: "local", timestamp: Date.now() });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // POST - simulate facilitator / generate mock proof or proxy to backend
  const body = req.body ?? {};
  const x402 = body.x402 ?? body; // accept either { x402: {...} } or direct fields

  // extract fields
  const to = x402.to ?? x402.employee ?? x402.address;
  const amount = x402.amount ?? x402.value ?? x402.salary;
  const periodId = x402.periodId ?? x402.period ?? x402.pid;

  if (!to || !amount || !periodId) {
    return res.status(400).json({ error: "missing required fields: to, amount, periodId (or provide x402 object)" });
  }

  // If BACKEND is configured attempt to proxy first (so centralized simulator/ledger is used)
  if (BACKEND) {
    try {
      const proxied = await proxyPost(BACKEND, { x402: { to, amount: String(amount), token: x402.token ?? x402.tokenAddress, periodId } });
      // return proxied response as-is
      return res.status(proxied.status).json({
        proxied: true,
        data: proxied.data,
      });
    } catch (err: any) {
      // fallback to local simulation
      // continue to local simulation below
    }
  }

  // Local simulation: build a deterministic proof blob and hash
  try {
    // validate address
    if (!ethers.isAddress(to)) {
      return res.status(400).json({ error: "invalid Ethereum/Cronos address in 'to'" });
    }

    const proofHex = buildProofHex(to, periodId, amount);
    // compute keccak256 over raw bytes
    const proofBytes = ethers.getBytes(proofHex);
    const proofHash = ethers.keccak256(proofBytes);

    return res.status(200).json({
      simulated: true,
      proof: proofHex,
      proofHash,
      meta: {
        generatedAt: Date.now(),
        x402: { to, amount: String(amount), token: x402.token ?? "", periodId },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: "simulation-failed", reason: err?.message || String(err) });
  }
}
