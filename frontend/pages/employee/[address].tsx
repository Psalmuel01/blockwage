import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import {
  getSalaryScheduleContract,
  getJsonRpcProvider,
  STABLECOIN_ADDRESS,
} from '../../lib/contracts';
import axios from 'axios';
import { ethers } from 'ethers';

type X402Body = {
  to: string;
  amount: string;
  token: string;
  periodId: string | number;
  meta?: Record<string, any>;
};

export default function EmployeeClaim() {
  const router = useRouter();
  const { address } = router.query as { address?: string };

  const [loading, setLoading] = useState(false);
  const [x402, setX402] = useState<X402Body | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<any | null>(null);

  useEffect(() => {
    if (!address) return;
    // If address is an array for some reason, pick first
    const addr = Array.isArray(address) ? address[0] : address;
    loadClaim(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function loadClaim(addr: string) {
    setLoading(true);
    setError(null);
    setX402(null);
    setSimResult(null);

    try {
      // Basic validation
      if (!addr) throw new Error('No address provided');
      if (!ethers.isAddress(addr)) {
        throw new Error('Invalid Ethereum/Cronos address');
      }

      const provider = getJsonRpcProvider();
      const schedule = getSalaryScheduleContract(provider);

      // nextExpectedPeriod may revert for unknown employees; handle gracefully
      let periodId: string | number = Math.floor(Date.now() / 1000);
      try {
        const next = await schedule.nextExpectedPeriod(addr);
        periodId = next.toString();
      } catch {
        // fallback: current unix ts (rounded down to seconds)
        periodId = Math.floor(Date.now() / 1000);
      }

      // get employee info
      let amountRaw = '0';
      let cadence = 2;
      let lastPaid = 0;
      let exists = false;
      try {
        const info: [ethers.BigNumberish, number, ethers.BigNumberish, boolean] =
          await schedule.getEmployee(addr);
        amountRaw = info?.[0]?.toString?.() ?? '0';
        cadence = Number(info?.[1] ?? 2);
        lastPaid = Number(info?.[2]?.toString?.() ?? 0);
        exists = Boolean(info?.[3]);
      } catch {
        // leave defaults
      }

      const body: X402Body = {
        to: addr,
        amount: amountRaw,
        token: STABLECOIN_ADDRESS || '',
        periodId,
        meta: {
          cadence,
          lastPaid,
          exists,
          generatedAt: Math.floor(Date.now() / 1000),
        },
      };

      setX402(body);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function downloadJSON() {
    if (!x402) return;
    const blob = new Blob([JSON.stringify(x402, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x402-claim-${x402.to}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyJSON() {
    if (!x402) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(x402));
      alert('x402 JSON copied to clipboard');
    } catch {
      alert('Copy failed - please select and copy manually');
    }
  }

  async function simulateFacilitator() {
    if (!x402) {
      setError('No x402 payload to simulate');
      return;
    }
    setSimResult(null);
    setError(null);
    setLoading(true);
    try {
      // Backend simulate endpoint. The backend should expose /simulate-facilitator
      // (or adjust NEXT_PUBLIC_BACKEND_URL accordingly).
      const backend = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000';
      const url = `${backend.replace(/\/$/, '')}/simulate-facilitator`;
      const resp = await axios.post(url, { x402 });
      setSimResult(resp.data);
    } catch (err: any) {
      setError('Simulation failed: ' + (err?.response?.data?.error || err?.message || String(err)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto py-6">
      <h1 className="text-2xl font-semibold mb-3">Claim Salary</h1>

      <div className="card">
        <div className="mb-4">
          <div className="label">Employee Address</div>
          <div className="mono">{address ?? '—'}</div>
        </div>

        {loading ? (
          <div>Preparing claim...</div>
        ) : error ? (
          <div className="text-red-500">Error: {error}</div>
        ) : x402 ? (
          <div>
            <div className="x402-instructions">
              <div className="flex items-center justify-between">
                <div>
                  <div className="label">to</div>
                  <div className="mono">{x402.to}</div>
                </div>
                <div>
                  <div className="label">token</div>
                  <div className="mono">{x402.token || 'not-configured'}</div>
                </div>
                <div>
                  <div className="label">periodId</div>
                  <div className="mono">{x402.periodId}</div>
                </div>
                <div>
                  <div className="label">amount (raw)</div>
                  <div className="mono">{x402.amount}</div>
                </div>
              </div>

              <div className="mt-3">
                <p className="muted">This page displays an x402-style payment request. A payer (scheduler/facilitator) should:</p>
                <ol className="mt-2 list-decimal ml-6 muted">
                  <li>Read the x402 JSON and perform a facilitator payment to transfer stablecoin to <code>{x402.to}</code>.</li>
                  <li>Obtain the facilitator proof from the facilitator system.</li>
                  <li>POST the proof to the payroll backend's verification endpoint (e.g. <code>/salary/verify</code>).</li>
                </ol>
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <button onClick={downloadJSON} className="btn btn-primary">
                Download JSON
              </button>
              <button onClick={copyJSON} className="btn btn-ghost">
                Copy JSON
              </button>
              <button onClick={simulateFacilitator} className="btn btn-ghost">
                Simulate Facilitator (demo)
              </button>
            </div>

            {simResult && (
              <div className="mt-4">
                <h4 className="font-semibold">Simulation Result</h4>
                <pre className="mt-2 p-3 bg-slate-50 rounded">
                  {typeof simResult === 'string' ? simResult : JSON.stringify(simResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div className="muted">No salary assigned or unable to load claim.</div>
        )}
      </div>

      <div className="mt-6 muted">
        <div>Tip: For demo flows, use the backend simulate-facilitator endpoint to generate a proof and then POST it to the payroll backend's verification endpoint to finish the payout.</div>
      </div>
    </div>
  );
}
