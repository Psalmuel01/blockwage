import { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { ethers } from "ethers";
import axios from "axios";

/**
 * Claim page
 *
 * Improvements:
 * - Robust handling of facilitator URL: prefer backend top-level `facilitatorUrl`,
 *   fallback to paymentRequirements.facilitatorUrl, and validate/base-normalize before use.
 * - Safer construction of facilitator endpoint using URL API.
 * - Clearer UI for missing facilitator URL (disables execute button).
 * - Robust EIP-712 signing attempts for both common ethers signer APIs.
 * - Deterministic base64 encoding of the signature (hex -> bytes -> b64).
 */

function hexToBase64(hex: string) {
  if (!hex) return "";
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) {
    // pad odd length
    hex = "0" + h;
  }
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  // convert to binary string
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa works in browsers
  return typeof window !== "undefined" ? window.btoa(binary) : "";
}

export default function ClaimPage() {
  const router = useRouter();

  const [employeeAddress, setEmployeeAddress] = useState("");
  const [status, setStatus] = useState<string>("");
  const [paymentReq, setPaymentReq] = useState<any | null>(null);
  const [backendFacilitatorUrl, setBackendFacilitatorUrl] = useState<
    string | null
  >(null);
  const [rawResponse, setRawResponse] = useState<any | null>(null);

  const BACKEND =
    process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

  // Prefill from ?employee= query and auto-check
  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query.employee;
    if (!q) return;
    const addr = Array.isArray(q) ? q[0] : q;
    if (addr && addr !== employeeAddress) {
      setEmployeeAddress(addr);
      void checkClaim(addr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.employee]);

  async function checkClaim(addrOverride?: string) {
    const addr = addrOverride ?? employeeAddress;
    if (!addr) {
      setStatus("Please enter your wallet address.");
      return;
    }

    setStatus("Checking salary...");
    setPaymentReq(null);
    setBackendFacilitatorUrl(null);
    setRawResponse(null);

    try {
      const url = `${BACKEND.replace(/\/$/, "")}/salary/claim/${addr}`;
      const res = await axios.get(url).catch((e) => e.response);

      if (!res) {
        setStatus("No response from backend");
        return;
      }

      setRawResponse(res.data ?? null);

      // Backend returns 402 when payment required (x402 spec)
      if (res.status === 402) {
        const pr =
          res.data.paymentRequirements ?? res.data.paymentrequirements ?? null;
        setPaymentReq(pr);
        // top-level facilitator url (backend may return facilitatorUrl at response root)
        setBackendFacilitatorUrl(
          res.data.facilitatorUrl ?? res.data.facilitator_url ?? null
        );
        setStatus("Payment required — ready to claim.");
      } else if (res.status === 200) {
        setStatus("Already paid for this period.");
      } else {
        setStatus(`Error: ${res.data?.error ?? "unknown"}`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err?.message ?? String(err)}`);
      setRawResponse(
        err?.response?.data ?? { error: err?.message ?? String(err) }
      );
    }
  }

  // Resolve an actionable facilitator base URL string if present
  function resolveFacilitatorBase(): string | null {
    // Prefer backend-level facilitator URL first, then paymentReq provided URL
    const candidate =
      backendFacilitatorUrl ||
      paymentReq?.facilitatorUrl ||
      paymentReq?.facilitator ||
      null;
    if (!candidate) return null;

    try {
      // Using URL to validate and normalize the facilitator base
      const u = new URL(candidate);
      // Keep the origin if path is root-like; if candidate contains a path, return full origin+path
      return `${u.origin}${
        u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname
      }`;
    } catch {
      // candidate might be a relative URL; try to prefix with https://
      try {
        const u2 = new URL(`https://${candidate}`);
        return `${u2.origin}${
          u2.pathname.endsWith("/") ? u2.pathname.slice(0, -1) : u2.pathname
        }`;
      } catch {
        return null;
      }
    }
  }

  // Execute: create signature and POST to facilitator /settle
  async function executePayment() {
    if (!paymentReq) {
      setStatus("No payment requirements available.");
      return;
    }

    setStatus("Preparing wallet signature...");
    try {
      if (typeof window === "undefined" || !(window as any).ethereum) {
        throw new Error("No injected wallet detected (window.ethereum).");
      }
      const win: any = window;
      const provider = new ethers.BrowserProvider(win.ethereum);
      const signer = await provider.getSigner();

      // domain/types/value based on x402 paymentRequirements (EIP-3009 / TransferWithAuthorization)
      const domain = {
        name: "USD Coin",
        version: "2",
        // paymentReq.network may be a CAIP string; try numeric fallback to Cronos testnet chain id 338
        chainId: Number(paymentReq?.network) || 338,
        verifyingContract: paymentReq.asset,
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const from = await signer.getAddress();
      const value = {
        from,
        to: paymentReq.payTo,
        value: paymentReq.maxAmountRequired,
        validAfter: 0,
        // short-lived validity
        validBefore: Math.floor(Date.now() / 1000) + 60 * 60,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
      };

      // Signing: support common patterns (_signTypedData for ethers v5, signTypedData for some v6 signers)
      let signatureHex: string;
      if ((signer as any).signTypedData) {
        // some v6 signers expose signTypedData(domain, types, value)
        signatureHex = await (signer as any).signTypedData(
          domain,
          types,
          value
        );
      } else if ((signer as any)._signTypedData) {
        // ethers v5 style
        signatureHex = await (signer as any)._signTypedData(
          domain,
          types,
          value
        );
      } else {
        // As a last resort, try to call provider.send('eth_signTypedData_v4', [...])
        // This is more invasive and wallet-specific, so we prefer the above.
        throw new Error(
          "Signer does not support typed-data signing via known methods."
        );
      }

      setStatus("Encoding signature and submitting to facilitator...");

      const signatureB64 = hexToBase64(signatureHex);

      // Resolve facilitator base and construct /settle endpoint safely
      const facBase = resolveFacilitatorBase();
      if (!facBase) {
        setStatus(
          "No valid facilitator URL provided by backend or payment requirements."
        );
        return;
      }

      // Build final settle URL in a safe way
      let settleUrl: string;
      try {
        const settle = new URL("/settle", facBase);
        settleUrl = settle.href;
      } catch {
        // fallback: just append
        settleUrl = facBase.replace(/\/$/, "") + "/settle";
      }

      // Post payload according to facilitator expectation
      const payload = {
        x402Version: 1,
        paymentHeader: signatureB64,
        paymentRequirements: paymentReq,
      };

      const resp = await axios.post(settleUrl, payload, { timeout: 15000 });

      setStatus(
        resp?.data?.txHash
          ? `Payment submitted — facilitator tx: ${resp.data.txHash}`
          : `Facilitator response: ${JSON.stringify(
              resp?.data ?? resp?.status ?? "ok"
            )}`
      );
    } catch (err: any) {
      // show any response body if available for easier debugging
      const body = err?.response?.data
        ? ` — ${JSON.stringify(err.response.data)}`
        : "";
      setStatus(`Error during payment: ${err?.message ?? String(err)}${body}`);
    }
  }

  const facilitatorDisplay = resolveFacilitatorBase() ?? "not provided";

  return (
    <>
      <Head>
        <title>Claim Salary — BlockWage</title>
      </Head>

      <div className="container mx-auto p-6 max-w-2xl">
        <h1 className="text-3xl font-bold mb-6">Claim Salary</h1>

        <div className="space-y-3">
          <input
            placeholder="Your wallet address (0x...)"
            value={employeeAddress}
            onChange={(e) => setEmployeeAddress(e.target.value)}
            className="w-full px-4 py-2 border rounded"
          />

          <div className="flex gap-2">
            <button
              onClick={() => void checkClaim()}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Check My Salary
            </button>

            <button
              onClick={() => {
                setEmployeeAddress("");
                setStatus("");
                setPaymentReq(null);
                setBackendFacilitatorUrl(null);
                setRawResponse(null);
              }}
              className="px-4 py-2 bg-gray-200 rounded"
            >
              Reset
            </button>
          </div>

          {status && <div className="p-4 bg-gray-100 rounded">{status}</div>}

          {paymentReq ? (
            <div className="p-4 border rounded">
              <h3 className="font-semibold mb-2">Payment Details</h3>

              <div className="grid gap-2">
                <div>
                  <strong>Amount:</strong>{" "}
                  <span className="mono">
                    {typeof paymentReq.maxAmountRequired === "string"
                      ? ethers.formatUnits(paymentReq.maxAmountRequired, 6)
                      : paymentReq.maxAmountRequired}{" "}
                    USDC
                  </span>
                </div>

                <div>
                  <strong>Pay to:</strong>{" "}
                  <code className="mono">{paymentReq.payTo}</code>
                </div>

                <div>
                  <strong>Asset (token):</strong>{" "}
                  <code className="mono">{paymentReq.asset}</code>
                </div>

                <div>
                  <strong>Resource:</strong>{" "}
                  <code className="mono">{paymentReq.resource}</code>
                </div>

                <div>
                  <strong>Facilitator (resolved):</strong>{" "}
                  <span className="mono">{facilitatorDisplay}</span>
                </div>

                {paymentReq.description && (
                  <div className="text-sm text-gray-600">
                    {paymentReq.description}
                  </div>
                )}

                <div>
                  <strong>Metadata</strong>
                  <pre className="mt-1 p-2 bg-white rounded text-xs overflow-x-auto">
                    {JSON.stringify(paymentReq.metadata ?? {}, null, 2)}
                  </pre>
                </div>

                <div className="mt-2">
                  <button
                    onClick={() => void executePayment()}
                    className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                    disabled={resolveFacilitatorBase() === null}
                  >
                    Sign & Claim Salary
                  </button>
                  {resolveFacilitatorBase() === null && (
                    <div className="text-sm mt-2 text-red-600">
                      No facilitator URL is available from backend or payment
                      requirements; cannot submit to facilitator.
                    </div>
                  )}
                </div>

                <details className="mt-3 p-2 bg-white rounded text-xs">
                  <summary className="cursor-pointer">
                    Raw backend response (debug)
                  </summary>
                  <pre className="mt-2 overflow-x-auto">
                    {JSON.stringify(
                      rawResponse ?? { paymentRequirements: paymentReq },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </div>
            </div>
          ) : (
            <div className="muted">
              No payment requirements. Enter your wallet address and click
              "Check My Salary".
            </div>
          )}
        </div>
      </div>
    </>
  );
}
