import { useContext, useEffect, useState } from "react";
import Head from "next/head";
import { WalletContext } from "./_app";
import {
  getBrowserProvider,
  getSalaryScheduleContract,
  getPayrollVaultContract,
  getStablecoinContract,
  getJsonRpcProvider,
  formatTokenAmount,
  parseTokenAmount,
  SALARY_SCHEDULE_ADDRESS,
  PAYROLL_VAULT_ADDRESS,
  STABLECOIN_ADDRESS,
} from "../lib/contracts";
import { ethers } from "ethers";
import axios from "axios";
import clsx from "clsx";

/**
 * Employer Dashboard + Embedded Claim Viewer (single page)
 *
 * Notes:
 * - This page implements:
 *   - Employer actions (assign employee, deposit payroll, trigger salary due)
 *   - Lightweight event view & employee info
 *   - Local claim viewer that constructs an x402 402-like response (for demo)
 *   - Simulate-facilitator call (POST to BACKEND_URL/simulate-facilitator or /simulate-facilitator)
 *
 * - Admin actions require wallet connect (MetaMask / Cronos-compatible) and the connected address to be the contracts' owner.
 *
 * Environment:
 * - NEXT_PUBLIC_RPC_URL
 * - NEXT_PUBLIC_BACKEND_URL (e.g. http://localhost:3000)
 * - NEXT_PUBLIC_* contract addresses (optional placeholders)
 */

type EmployeeInfo = {
  salary: string;
  cadence: number;
  lastPaid: number;
  exists: boolean;
};

const DEFAULT_BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3000";

/* Utility: short address for display */
function short(addr?: string) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export default function Dashboard() {
  const wallet = useContext(WalletContext);
  const [status, setStatus] = useState<string | null>(null);

  // Form state: assign employee
  const [assignAddr, setAssignAddr] = useState("");
  const [assignSalary, setAssignSalary] = useState("1"); // human units
  const [assignCadence, setAssignCadence] = useState<number>(2); // 0 hourly,1 biweekly,2 monthly
  const [assignLastPaid, setAssignLastPaid] = useState<number>(0);

  // Deposit form
  const [depositPeriodId, setDepositPeriodId] = useState<number>(
    Math.floor(Date.now() / 1000)
  );
  const [depositAmount, setDepositAmount] = useState("1");

  // Trigger salary
  const [triggerEmployee, setTriggerEmployee] = useState("");
  const [triggerPeriodId, setTriggerPeriodId] = useState<number>(
    Math.floor(Date.now() / 1000)
  );

  // Employee info lookup
  const [lookupAddress, setLookupAddress] = useState("");
  const [employeeInfo, setEmployeeInfo] = useState<EmployeeInfo | null>(null);
  const [nextPeriod, setNextPeriod] = useState<number | null>(null);

  // Simple event list (SalaryDue events)
  const [events, setEvents] = useState<any[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const rpcProvider = getJsonRpcProvider();

  useEffect(() => {
    // load recent SalaryDue events (best-effort)
    fetchEvents().catch((e) => console.warn("fetchEvents failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchEvents() {
    if (!SALARY_SCHEDULE_ADDRESS) {
      setEvents([]);
      return;
    }
    setLoadingEvents(true);
    try {
      const provider = rpcProvider;
      const contract = getSalaryScheduleContract(provider);
      const latest = await provider.getBlockNumber();
      // conservative scan range: last 5000 blocks (adjust as needed)
      const fromBlock = Math.max(0, latest - 5000);
      const evts = await contract.queryFilter(
        contract.filters.SalaryDue(),
        fromBlock,
        latest
      );
      const mapped = evts.map((e: any) => ({
        employee: e.args?.[0],
        amount: e.args?.[1]?.toString(),
        token: e.args?.[2],
        periodId: e.args?.[3]?.toString(),
        txHash: e.transactionHash,
        blockNumber: e.blockNumber,
      }));
      setEvents(mapped.reverse());
    } catch (err) {
      console.error("Failed to fetch events", err);
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }

  /* ===========================
     Admin actions (wallet-signed)
     =========================== */

  async function assignEmployeeHandler(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Assigning employee...");
    try {
      if (!wallet || !wallet.provider) throw new Error("Connect wallet first");
      const signer = await wallet.provider.getSigner();
      const schedule = getSalaryScheduleContract(signer);
      // parse salary to smallest-unit (assume USDC 6 decimals)
      const amountBn = await parseTokenInput(
        assignSalary,
        STABLECOIN_ADDRESS,
        signer
      );
      const tx = await schedule.assignEmployee(
        assignAddr,
        amountBn,
        assignCadence,
        assignLastPaid
      );
      setStatus("Tx sent: " + tx.hash);
      await tx.wait();
      setStatus("Employee assigned. Refetching info...");
      await refreshEmployee(assignAddr);
    } catch (err: any) {
      console.error(err);
      setStatus("Error: " + (err?.message || String(err)));
    }
  }

  async function depositHandler(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Depositing payroll...");
    try {
      if (!wallet || !wallet.provider) throw new Error("Connect wallet first");
      const signer = await wallet.provider.getSigner();
      const token = getStablecoinContract(STABLECOIN_ADDRESS, signer);
      const vault = getPayrollVaultContract(signer);
      const amountBn = await parseTokenInput(
        depositAmount,
        STABLECOIN_ADDRESS,
        signer
      );
      // approve token to vault
      const allowance = await token.allowance(
        await signer.getAddress(),
        PAYROLL_VAULT_ADDRESS
      );
      if (allowance < amountBn) {
        const approveTx = await token.approve(PAYROLL_VAULT_ADDRESS, amountBn);
        setStatus("Approving token tx: " + approveTx.hash);
        await approveTx.wait();
      }
      const tx = await vault.depositPayroll(depositPeriodId, amountBn);
      setStatus("Deposit tx: " + tx.hash);
      await tx.wait();
      setStatus("Deposit complete");
      await fetchEvents();
    } catch (err: any) {
      console.error(err);
      setStatus("Error: " + (err?.message || String(err)));
    }
  }

  async function triggerHandler(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Triggering salary due...");
    try {
      if (!wallet || !wallet.provider) throw new Error("Connect wallet first");
      const signer = await wallet.provider.getSigner();
      const schedule = getSalaryScheduleContract(signer);
      const tx = await schedule.triggerSalaryDue(
        triggerEmployee,
        triggerPeriodId
      );
      setStatus("Trigger tx: " + tx.hash);
      await tx.wait();
      setStatus("SalaryDue triggered successfully");
      await fetchEvents();
    } catch (err: any) {
      console.error(err);
      setStatus("Error: " + (err?.message || String(err)));
    }
  }

  /* ===========================
     Lookup & Claim viewer
     =========================== */

  async function refreshEmployee(address?: string) {
    const addr = address || lookupAddress;
    if (!addr) return;
    setStatus("Fetching employee info...");
    try {
      const provider = getJsonRpcProvider();
      const schedule = getSalaryScheduleContract(provider);
      const info: [ethers.BigNumberish, number, ethers.BigNumberish, boolean] =
        await schedule.getEmployee(addr);
      const salary = info[0].toString();
      const cadence = Number(info[1]);
      const lastPaid = Number(info[2]?.toString() || "0");
      const exists = Boolean(info[3]);
      setEmployeeInfo({
        salary: salary,
        cadence,
        lastPaid,
        exists,
      });
      // next expected period
      try {
        const np: ethers.BigNumberish = await schedule.nextExpectedPeriod(addr);
        setNextPeriod(Number(np.toString()));
      } catch {
        setNextPeriod(null);
      }
      setStatus("Employee info fetched");
    } catch (err: any) {
      console.error(err);
      setStatus(
        "Error fetching employee info: " + (err?.message || String(err))
      );
      setEmployeeInfo(null);
      setNextPeriod(null);
    }
  }

  function buildX402Body(addr: string) {
    if (!employeeInfo) return null;
    return {
      to: addr,
      amount: employeeInfo.salary,
      token: STABLECOIN_ADDRESS,
      periodId: nextPeriod ?? Math.floor(Date.now() / 1000),
      meta: {
        cadence: employeeInfo.cadence,
        lastPaid: employeeInfo.lastPaid,
      },
    };
  }

  async function simulateFacilitatorForClaim(addr: string) {
    if (!addr) return;
    setStatus("Simulating facilitator payment...");
    try {
      const x402 = buildX402Body(addr);
      if (!x402) throw new Error("No x402 data");
      // call backend simulate endpoint
      const backend = process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND;
      const url = `${backend.replace(/\/$/, "")}/simulate-facilitator`;
      // we post the raw x402 body for the backend to create a mock proof
      const resp = await axios.post(url, { x402 });
      setStatus(
        "Simulator response: " +
          (resp.data?.proof ? "proof generated" : JSON.stringify(resp.data))
      );
      return resp.data;
    } catch (err: any) {
      console.error(err);
      setStatus("Simulator error: " + (err?.message || String(err)));
      return null;
    }
  }

  /* ===========================
     Helpers
     =========================== */

  async function parseTokenInput(
    human: string,
    tokenAddr: string,
    providerOrSigner?: any
  ) {
    // parse using token decimals if possible
    try {
      const token = getStablecoinContract(
        tokenAddr,
        providerOrSigner ?? getJsonRpcProvider()
      );
      const decimals = Number(await token.decimals());
      return ethers.parseUnits(human, decimals);
    } catch {
      // default to 6 decimals (USDC)
      return ethers.parseUnits(human, 6);
    }
  }

  /* ===========================
     UI render
     =========================== */

  return (
    <>
      <Head>
        <title>BlockWage — Employer Dashboard</title>
      </Head>

      <div className="container mx-auto">
        <h1 className="text-3xl font-bold mb-3">
          BlockWage — Employer Dashboard
        </h1>
        <p className="muted mb-6">
          Connected:{" "}
          <span className="mono">
            {wallet.address ? short(wallet.address) : "Not connected"}
          </span>
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Left: Admin forms */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-2">Assign Employee</h2>
            <form onSubmit={assignEmployeeHandler} className="space-y-3">
              <label className="block">
                <div className="label">Employee address</div>
                <input
                  value={assignAddr}
                  onChange={(e) => setAssignAddr(e.target.value)}
                  placeholder="0x..."
                  className="input w-full border rounded-md px-3 py-2"
                />
              </label>

              <label className="block">
                <div className="label">Salary (in token units e.g. USDC)</div>
                <input
                  value={assignSalary}
                  onChange={(e) => setAssignSalary(e.target.value)}
                  placeholder="1.0"
                  className="input w-full border rounded-md px-3 py-2"
                />
              </label>

              <label className="block">
                <div className="label">Cadence</div>
                <select
                  value={assignCadence}
                  onChange={(e) => setAssignCadence(Number(e.target.value))}
                  className="input w-full border rounded-md px-3 py-2"
                >
                  <option value={2}>Monthly</option>
                  <option value={1}>Biweekly</option>
                  <option value={0}>Hourly</option>
                </select>
              </label>

              <label className="block">
                <div className="label">
                  Initial last paid timestamp (optional)
                </div>
                <input
                  type="number"
                  value={assignLastPaid}
                  onChange={(e) => setAssignLastPaid(Number(e.target.value))}
                  className="input w-full border rounded-md px-3 py-2"
                />
              </label>

              <div className="flex items-center space-x-3">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!wallet.address}
                >
                  Assign employee
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setAssignAddr("");
                    setAssignSalary("1");
                    setAssignLastPaid(0);
                  }}
                >
                  Reset
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h2 className="text-xl font-semibold mb-2">Deposit Payroll</h2>
            <form onSubmit={depositHandler} className="space-y-3">
              <label>
                <div className="label">Period ID (numeric)</div>
                <input
                  type="number"
                  value={depositPeriodId}
                  onChange={(e) => setDepositPeriodId(Number(e.target.value))}
                  className="input w-full border rounded-md px-3 py-2"
                />
              </label>

              <label>
                <div className="label">Amount</div>
                <input
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="input w-full border rounded-md px-3 py-2"
                />
              </label>

              <div className="flex items-center space-x-3">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!wallet.address}
                >
                  Deposit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setDepositAmount("1");
                    setDepositPeriodId(Math.floor(Date.now() / 1000));
                  }}
                >
                  Reset
                </button>
              </div>
            </form>

            <div className="hr my-4" />

            <h3 className="font-semibold">Trigger Salary Due</h3>
            <form onSubmit={triggerHandler} className="space-y-3 mt-3">
              <input
                placeholder="Employee address to trigger"
                value={triggerEmployee}
                onChange={(e) => setTriggerEmployee(e.target.value)}
                className="input w-full border rounded-md px-3 py-2"
              />
              <input
                type="number"
                value={triggerPeriodId}
                onChange={(e) => setTriggerPeriodId(Number(e.target.value))}
                className="input w-full border rounded-md px-3 py-2"
              />
              <div>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!wallet.address}
                >
                  Trigger SalaryDue
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Lookup / Claim viewer */}
        <div className="card mt-6">
          <h2 className="text-xl font-semibold mb-2">
            Employee lookup & Claim viewer
          </h2>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <input
                placeholder="Enter employee address"
                value={lookupAddress}
                onChange={(e) => setLookupAddress(e.target.value)}
                className="input w-full border rounded-md px-3 py-2"
              />
            </div>
            <div>
              <button
                onClick={() => refreshEmployee()}
                className="btn btn-primary"
                disabled={!lookupAddress}
              >
                Fetch Employee
              </button>
            </div>
            <div>
              <button
                onClick={async () => {
                  if (!lookupAddress) return;
                  const resp = await simulateFacilitatorForClaim(lookupAddress);
                  // optionally auto-call backend verify here for demo
                  console.log("simulateFacilitatorForClaim returned", resp);
                }}
                className="btn btn-ghost"
                disabled={!lookupAddress}
              >
                Simulate Facilitator (demo)
              </button>
            </div>
          </div>

          <div className="mt-4">
            {employeeInfo ? (
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="label">Employee</div>
                    <div className="mono">{lookupAddress}</div>
                  </div>
                  <div className="text-right">
                    <div className="label">Assigned salary (raw)</div>
                    <div className="mono">{employeeInfo.salary}</div>
                  </div>
                </div>

                <div className="mt-3 grid md:grid-cols-3 gap-3">
                  <div>
                    <div className="label">Cadence</div>
                    <div>
                      {employeeInfo.cadence === 2
                        ? "Monthly"
                        : employeeInfo.cadence === 1
                        ? "Biweekly"
                        : "Hourly"}
                    </div>
                  </div>
                  <div>
                    <div className="label">Last Paid (unix)</div>
                    <div>{employeeInfo.lastPaid || "never"}</div>
                  </div>
                  <div>
                    <div className="label">Next Period</div>
                    <div>
                      {nextPeriod
                        ? new Date(nextPeriod * 1000).toISOString()
                        : "unknown"}
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <h3 className="font-semibold">x402 Claim Preview</h3>
                  <div className="x402-instructions mt-2">
                    <div className="grid md:grid-cols-2 gap-2">
                      <div>
                        <div className="label">to</div>
                        <div className="mono">{lookupAddress}</div>
                      </div>
                      <div>
                        <div className="label">token</div>
                        <div className="mono">
                          {STABLECOIN_ADDRESS || "not-configured"}
                        </div>
                      </div>
                      <div>
                        <div className="label">amount (raw)</div>
                        <div className="mono">{employeeInfo.salary}</div>
                      </div>
                      <div>
                        <div className="label">periodId</div>
                        <div className="mono">
                          {nextPeriod ?? Math.floor(Date.now() / 1000)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <a
                        className={clsx("btn btn-primary")}
                        href={`/employee/${lookupAddress}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Claim Page
                      </a>

                      <button
                        className="btn btn-ghost"
                        onClick={async () => {
                          // open a simple popup with JSON body for 402 (client-side)
                          const body = buildX402Body(lookupAddress);
                          if (!body) return;
                          const w = window.open(
                            "",
                            "_blank",
                            "width=600,height=600"
                          );
                          if (!w) return;
                          w.document.body.style.fontFamily =
                            "Inter, system-ui, sans-serif";
                          w.document.title = `Claim — ${short(lookupAddress)}`;
                          w.document.body.innerHTML = `
                            <div style="padding:20px">
                              <h2>402 Payment Required (x402)</h2>
                              <pre style="background:#f3f4f6;padding:12px;border-radius:8px">${JSON.stringify(
                                body,
                                null,
                                2
                              )}</pre>
                              <p>Use a facilitator to pay the requested amount. For demo, use the backend simulate endpoint.</p>
                            </div>
                          `;
                        }}
                      >
                        Preview 402 JSON
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="muted">
                No employee loaded. Enter an address and click &quot;Fetch
                Employee&quot;.
              </div>
            )}
          </div>
        </div>

        {/* Events & status */}
        <div className="card mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Recent SalaryDue Events</h2>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost" onClick={() => fetchEvents()}>
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-3">
            {loadingEvents ? (
              <div>Loading events...</div>
            ) : events.length === 0 ? (
              <div className="muted">No recent events found.</div>
            ) : (
              <table className="table mt-2">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Amount (raw)</th>
                    <th>Token</th>
                    <th>Period</th>
                    <th>Tx</th>
                    <th>Block</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev, idx) => (
                    <tr key={idx}>
                      <td className="mono">{ev.employee}</td>
                      <td className="mono">{ev.amount}</td>
                      <td className="mono">{ev.token}</td>
                      <td className="mono">{ev.periodId}</td>
                      <td>
                        <a
                          href={`https://testnet.cronoscan.com/tx/${ev.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mono underline"
                        >
                          {short(ev.txHash)}
                        </a>
                      </td>
                      <td>{ev.blockNumber}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Status footer */}
        <div className="mt-4">
          <div className="muted">Status: {status ?? "idle"}</div>
        </div>
      </div>
    </>
  );
}

/* =========================
   Note: For a production-ready frontend we would:
   - Add the dynamic route at /pages/employee/[address].tsx that returns actual 402 status via Next API or serverless function,
   - Implement the API route pages/api/claim/[address].ts to respond with HTTP 402 & x402 JSON (server-side),
   - Integrate with the backend /simulate-facilitator endpoint (server-side) which creates facilitator proofs for demo,
   - Add robust error handling, pagination for events, and improved UX flows.
   The Dashboard here includes a claim preview and Open Claim Page link for demo/testing.
   ========================= */
