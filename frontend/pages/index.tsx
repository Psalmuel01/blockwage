import React, {
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import Head from "next/head";
import { WalletContext } from "./_app";
import {
  getBrowserProvider,
  getSalaryScheduleContract,
  getPayrollVaultContract,
  getStablecoinContract,
  getJsonRpcProvider,
  parseTokenAmount,
  SALARY_SCHEDULE_ADDRESS,
  PAYROLL_VAULT_ADDRESS,
  STABLECOIN_ADDRESS,
} from "../lib/contracts";
import { ethers } from "ethers";
import axios from "axios";
import clsx from "clsx";

import {
  isValidAddress,
  isPositiveNumberString,
  isIntegerString,
  validateAssignForm as validateAssignFormUtil,
  validateDepositForm as validateDepositFormUtil,
  validateTriggerForm as validateTriggerFormUtil,
  errorMapToMessage,
} from "../lib/validation";
import { useLogger } from "../lib/logger";

/**
 * Employer Dashboard — now using shared validation and logging utilities.
 *
 * Key changes:
 * - Validation helpers imported from `frontend/lib/validation`
 * - Component-local logger uses `useLogger` from `frontend/lib/logger`
 *
 * Behaviour is intentionally unchanged; this refactor extracts shared logic
 * so other pages/components can reuse it.
 */

type EmployeeInfo = {
  salary: string;
  cadence: 0 | 1 | 2 | 3;
  lastPaid: number;
  exists: boolean;
};

const DEFAULT_BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3000";

/* Small helpers */
const short = (addr?: string) =>
  addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "";
const nowISO = () => new Date().toISOString();

export default function Dashboard() {
  const wallet = useContext(WalletContext);
  const [status, setStatus] = useState<string | null>(null);

  // use shared logger hook
  const { logs, addLog, clearLogs } = useLogger();

  // transient UI alert
  const [alert, setAlert] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const alertTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (alertTimer.current) clearTimeout(alertTimer.current);
    };
  }, []);
  const showAlert = useCallback(
    (type: "success" | "error" | "info", text: string, ttl = 6000) => {
      setAlert({ type, text });
      if (alertTimer.current) clearTimeout(alertTimer.current);
      alertTimer.current = setTimeout(() => setAlert(null), ttl);
    },
    []
  );

  // Form state: assign employee
  const [assignAddr, setAssignAddr] = useState("");
  const [assignSalary, setAssignSalary] = useState("1"); // human units
  const [assignCadence, setAssignCadence] = useState<number>(3); // 0 minute, 1 hourly, 2 biweekly, 3 monthly
  const [assignLastPaid, setAssignLastPaid] = useState<number>(0);
  const [assignErrors, setAssignErrors] = useState<Record<string, string>>({});

  // Deposit form
  const [depositPeriodId, setDepositPeriodId] = useState<string>(
    String(Math.floor(Date.now() / 1000))
  );
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositErrors, setDepositErrors] = useState<Record<string, string>>(
    {}
  );

  // Trigger salary
  const [triggerEmployee, setTriggerEmployee] = useState("");
  const [triggerPeriodId, setTriggerPeriodId] = useState<string>(
    String(Math.floor(Date.now() / 1000))
  );
  const [triggerErrors, setTriggerErrors] = useState<Record<string, string>>(
    {}
  );

  // Employee info lookup
  const [lookupAddress, setLookupAddress] = useState("");
  const [employeeInfo, setEmployeeInfo] = useState<EmployeeInfo | null>(null);
  const [nextPeriod, setNextPeriod] = useState<number | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Events
  const [events, setEvents] = useState<any[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const rpcProvider = useMemo(() => getJsonRpcProvider(), []);

  // Prefer browser provider (wallet) for reads when available
  const getReadProvider = useCallback(() => {
    if (wallet && (wallet as any).provider) return (wallet as any).provider;
    const bp = getBrowserProvider();
    if (bp) return bp;
    return rpcProvider;
  }, [wallet, rpcProvider]);

  // Central error helper
  const handleActionError = useCallback(
    (action: string, err: any) => {
      const msg = err?.message || String(err);
      addLog({
        level: "error",
        action: `${action}_failed`,
        message: msg,
        meta: err,
      });
      setStatus(`${action} failed: ${msg}`);
      showAlert("error", `${action} failed: ${msg}`);
    },
    [addLog, showAlert]
  );

  useEffect(() => {
    const to = setTimeout(() => {
      fetchEvents().catch((e) =>
        addLog({
          level: "error",
          action: "fetchEvents",
          message: "initial fetch failed",
          meta: e,
        })
      );
    }, 150);
    return () => clearTimeout(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchEvents = useCallback(async () => {
    addLog({ level: "debug", action: "fetchEvents", message: "clicked/auto" });
    if (!SALARY_SCHEDULE_ADDRESS) {
      addLog({
        level: "info",
        action: "fetchEvents",
        message: "SalarySchedule address not configured; skipping events",
      });
      setEvents([]);
      return;
    }
    setLoadingEvents(true);
    try {
      const provider = getReadProvider();
      let latest: number;
      try {
        const blockNumber = await provider.getBlockNumber();
        latest = Number(blockNumber);
      } catch (err) {
        addLog({
          level: "error",
          action: "fetchEvents",
          message: "Provider unavailable",
          meta: String(err),
        });
        setStatus(
          "RPC provider unavailable. Connect a wallet or set NEXT_PUBLIC_RPC_URL."
        );
        setEvents([]);
        setLoadingEvents(false);
        return;
      }
      const contract = getSalaryScheduleContract(provider);
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
      addLog({
        level: "info",
        action: "fetchEvents",
        message: `loaded ${mapped.length} events`,
      });
    } catch (err) {
      addLog({
        level: "error",
        action: "fetchEvents",
        message: "Failed to fetch events",
        meta: err,
      });
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }, [addLog, getReadProvider]);

  /* ===========================
     Form validation helpers (use shared utils)
     =========================== */
  const validateAssignForm = useCallback(() => {
    const errs = validateAssignFormUtil({
      addr: assignAddr,
      salary: assignSalary,
      cadence: assignCadence,
      lastPaid: assignLastPaid,
    });
    setAssignErrors(errs);
    return Object.keys(errs).length === 0;
  }, [assignAddr, assignSalary, assignCadence, assignLastPaid]);

  const validateDepositForm = useCallback(() => {
    const errs = validateDepositFormUtil({
      periodId: depositPeriodId,
      amount: depositAmount,
    });
    setDepositErrors(errs);
    return Object.keys(errs).length === 0;
  }, [depositPeriodId, depositAmount]);

  const validateTriggerForm = useCallback(() => {
    const errs = validateTriggerFormUtil({
      employee: triggerEmployee,
      periodId: triggerPeriodId,
    });
    setTriggerErrors(errs);
    return Object.keys(errs).length === 0;
  }, [triggerEmployee, triggerPeriodId]);

  /* ===========================
     Action handlers
     =========================== */

  const assignEmployeeHandler = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault?.();
      addLog({
        level: "debug",
        action: "AssignEmployee_clicked",
        message: "Assign button clicked",
        meta: { assignAddr, assignSalary, assignCadence, assignLastPaid },
      });
      if (!validateAssignForm()) {
        addLog({
          level: "error",
          action: "AssignEmployee_validate",
          message: "validation failed",
          meta: assignErrors,
        });
        showAlert("error", "Please fix validation errors before submitting.");
        return;
      }
      setStatus("Assigning employee...");
      try {
        if (!(wallet && (wallet as any).provider)) {
          addLog({
            level: "info",
            action: "AssignEmployee_connect",
            message: "Wallet not connected; prompting connect",
          });
          await wallet?.connect?.();
          if (!(wallet && (wallet as any).provider))
            throw new Error("Wallet connection required for admin actions.");
        }
        if (!SALARY_SCHEDULE_ADDRESS)
          throw new Error("SalarySchedule contract address not configured.");

        const signer = await (wallet as any).provider.getSigner();
        const schedule = getSalaryScheduleContract(signer);

        const amt = await parseTokenAmount(
          assignSalary,
          STABLECOIN_ADDRESS,
          signer
        );
        addLog({
          level: "info",
          action: "AssignEmployee_tx",
          message: "sending assignEmployee transaction",
          meta: { to: assignAddr, amount: assignSalary },
        });
        const tx = await schedule.assignEmployee(
          assignAddr,
          amt,
          assignCadence,
          assignLastPaid
        );
        showAlert("info", `Transaction sent: ${tx.hash}`);
        addLog({
          level: "debug",
          action: "AssignEmployee_tx_sent",
          message: "txSent",
          meta: tx.hash,
        });
        await tx.wait();
        addLog({
          level: "info",
          action: "AssignEmployee_tx_mined",
          message: "tx mined",
          meta: tx.hash,
        });
        setStatus("Employee assigned successfully.");
        showAlert("success", "Employee assigned.");
        await refreshEmployee(assignAddr);
      } catch (err) {
        handleActionError("AssignEmployee", err);
      }
    },
    [
      addLog,
      assignAddr,
      assignSalary,
      assignCadence,
      assignLastPaid,
      validateAssignForm,
      assignErrors,
      wallet,
      handleActionError,
    ]
  );

  const depositHandler = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault?.();
      addLog({
        level: "debug",
        action: "Deposit_clicked",
        message: "Deposit button clicked",
        meta: { depositPeriodId, depositAmount },
      });
      if (!validateDepositForm()) {
        addLog({
          level: "error",
          action: "Deposit_validate",
          message: "validation failed",
          meta: depositErrors,
        });
        showAlert("error", "Please fix deposit form errors.");
        return;
      }
      setStatus("Depositing payroll...");
      try {
        if (!(wallet && (wallet as any).provider)) {
          addLog({
            level: "info",
            action: "Deposit_connect",
            message: "Wallet not connected; prompting connect",
          });
          await wallet?.connect?.();
          if (!(wallet && (wallet as any).provider))
            throw new Error("Wallet connection required for admin actions.");
        }
        if (!STABLECOIN_ADDRESS)
          throw new Error("Stablecoin token address not configured.");
        if (!PAYROLL_VAULT_ADDRESS)
          throw new Error("PayrollVault contract address not configured.");
        const signer = await (wallet as any).provider.getSigner();
        const token = getStablecoinContract(STABLECOIN_ADDRESS, signer);
        const vault = getPayrollVaultContract(signer);
        const amountBn = await parseTokenAmount(
          depositAmount,
          STABLECOIN_ADDRESS,
          signer
        );

        // Check allowance first and request approve only if needed
        const ownerAddr = await signer.getAddress();
        const allowance = await token.allowance(
          ownerAddr,
          PAYROLL_VAULT_ADDRESS
        );
        if (BigInt(allowance.toString()) < BigInt(amountBn.toString())) {
          addLog({
            level: "info",
            action: "Deposit_approve",
            message: "Approving token",
            meta: { amount: depositAmount },
          });
          const approveTx = await token.approve(
            PAYROLL_VAULT_ADDRESS,
            amountBn
          );
          showAlert("info", `Approve tx sent: ${approveTx.hash}`);
          await approveTx.wait();
          addLog({
            level: "debug",
            action: "Deposit_approve_mined",
            message: "approve mined",
            meta: approveTx.hash,
          });
        }

        const tx = await vault.depositPayroll(
          Number(depositPeriodId),
          amountBn
        );
        showAlert("info", `Deposit tx sent: ${tx.hash}`);
        addLog({
          level: "info",
          action: "Deposit_tx",
          message: "deposit sent",
          meta: tx.hash,
        });
        await tx.wait();
        addLog({
          level: "info",
          action: "Deposit_mined",
          message: "deposit mined",
          meta: tx.hash,
        });
        setStatus("Deposit successful.");
        showAlert("success", "Deposit successful.");
        await fetchEvents();
      } catch (err) {
        handleActionError("Deposit", err);
      }
    },
    [
      addLog,
      depositPeriodId,
      depositAmount,
      validateDepositForm,
      depositErrors,
      wallet,
      handleActionError,
      fetchEvents,
    ]
  );

  const triggerHandler = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault?.();
      addLog({
        level: "debug",
        action: "Trigger_clicked",
        message: "Trigger button clicked",
        meta: { triggerEmployee, triggerPeriodId },
      });
      if (!validateTriggerForm()) {
        addLog({
          level: "error",
          action: "Trigger_validate",
          message: "validation failed",
          meta: triggerErrors,
        });
        showAlert("error", "Please fix trigger form errors.");
        return;
      }
      setStatus("Triggering salary due...");
      try {
        if (!(wallet && (wallet as any).provider)) {
          addLog({
            level: "info",
            action: "Trigger_connect",
            message: "Wallet not connected; prompting connect",
          });
          await wallet?.connect?.();
          if (!(wallet && (wallet as any).provider))
            throw new Error("Wallet connection required for admin actions.");
        }
        if (!SALARY_SCHEDULE_ADDRESS)
          throw new Error("SalarySchedule contract address not configured.");
        const signer = await (wallet as any).provider.getSigner();
        const schedule = getSalaryScheduleContract(signer);
        const tx = await schedule.triggerSalaryDue(
          triggerEmployee,
          Number(triggerPeriodId)
        );
        showAlert("info", `Trigger tx sent: ${tx.hash}`);
        addLog({
          level: "info",
          action: "Trigger_tx",
          message: "trigger sent",
          meta: tx.hash,
        });
        await tx.wait();
        addLog({
          level: "info",
          action: "Trigger_mined",
          message: "trigger mined",
          meta: tx.hash,
        });
        setStatus("Triggered SalaryDue.");
        showAlert("success", "SalaryDue triggered.");
        await fetchEvents();
      } catch (err) {
        handleActionError("Trigger", err);
      }
    },
    [
      addLog,
      triggerEmployee,
      triggerPeriodId,
      validateTriggerForm,
      triggerErrors,
      wallet,
      handleActionError,
      fetchEvents,
    ]
  );

  /* ===========================
     Lookup & Claim viewer
     =========================== */
  const refreshEmployee = useCallback(
    async (address?: string) => {
      const addr = address || lookupAddress;
      if (!addr) {
        setLookupError("Please provide an employee address to lookup.");
        return;
      }
      if (!isValidAddress(addr)) {
        setLookupError("Invalid address format.");
        return;
      }
      setLookupError(null);
      setStatus("Fetching employee info...");
      try {
        const provider = getReadProvider();
        const schedule = getSalaryScheduleContract(provider);

        const code = await provider.getCode(SALARY_SCHEDULE_ADDRESS);
        if (code === "0x")
          throw new Error(
            "SalarySchedule contract not found at configured address. Check network and contract address."
          );

        const info: [
          ethers.BigNumberish,
          number,
          ethers.BigNumberish,
          boolean
        ] = await schedule.getEmployee(addr);
        const salary = info[0].toString();
        const cadence = Number(info[1]);
        const lastPaid = Number(info[2]?.toString() || "0");
        const exists = Boolean(info[3]);

        if (!exists) {
          setLookupError(
            "Employee not found. This address has not been assigned."
          );
          setEmployeeInfo(null);
          setNextPeriod(null);
          setStatus("Employee not found");
          addLog({
            level: "info",
            action: "RefreshEmployee",
            message: "employee not found",
            meta: { addr },
          });
          return;
        }

        setEmployeeInfo({ salary, cadence, lastPaid, exists });

        try {
          const np: ethers.BigNumberish = await schedule.nextExpectedPeriod(
            addr
          );
          setNextPeriod(Number(np.toString()));
        } catch {
          setNextPeriod(null);
        }
        setStatus("Employee info fetched");
        addLog({
          level: "info",
          action: "RefreshEmployee",
          message: "employee info fetched",
          meta: { addr },
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes("could not decode result data")) {
          setLookupError(
            "Employee not found or contract error. Verify the address is assigned and you're on the correct network."
          );
        } else setLookupError(msg);
        addLog({
          level: "error",
          action: "RefreshEmployee_failed",
          message: msg,
          meta: err,
        });
        setStatus("Error fetching employee info: " + msg);
        setEmployeeInfo(null);
        setNextPeriod(null);
      }
    },
    [lookupAddress, getReadProvider, addLog]
  );

  const buildX402Body = useCallback(
    (addr: string) => {
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
    },
    [employeeInfo, nextPeriod]
  );

  const simulateFacilitatorForClaim = useCallback(
    async (addr: string) => {
      if (!addr) {
        showAlert("error", "Employee address required for simulation.");
        return null;
      }

      const backend = process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND;
      const baseUrl = backend.replace(/\/$/, "");

      setStatus("Claiming salary...");
      addLog({
        level: "info",
        action: "SimulateFacilitator",
        message: "Starting claim flow",
        meta: { addr },
      });

      try {
        // Step 1: Claim salary (x402)
        let x402: any;
        try {
          await axios.get(`${baseUrl}/salary/claim/${addr}`);
        } catch (err: any) {
          // Axios throws on 402
          if (err.response?.status === 402 && err.response?.data?.x402) {
            x402 = err.response.data.x402;
            addLog({
              level: "info",
              action: "SalaryClaimed",
              message: "Payment required received",
              meta: x402,
            });
            showAlert("info", "Payment required; proceeding with simulator.");
          } else {
            throw err;
          }
        }

        if (!x402) {
          showAlert("error", "No x402 payload returned from claim.");
          return null;
        }

        setStatus("Simulating facilitator...");
        // Step 2: Call simulator
        const simulateResp = await axios.post(
          `${baseUrl}/simulate-facilitator`,
          { x402 }
        );
        const facilitatorProof = simulateResp.data?.proof;
        if (!facilitatorProof) {
          showAlert("error", "Simulator did not return a proof.");
          addLog({
            level: "error",
            action: "SimulateFacilitator",
            message: "No proof returned",
            meta: simulateResp.data,
          });
          return null;
        }
        addLog({
          level: "info",
          action: "SimulateFacilitator",
          message: "Proof generated",
          meta: { proofSnippet: facilitatorProof.slice(0, 20) },
        });
        showAlert("success", "Simulator proof generated.");

        setStatus("Verifying salary...");
        // Step 3: Verify
        const verifyResp = await axios.post(`${baseUrl}/salary/verify`, {
          facilitatorProof,
          employee: addr,
          periodId: x402.periodId,
        });
        addLog({
          level: "info",
          action: "SalaryVerified",
          message: "Salary released successfully",
          meta: verifyResp.data,
        });
        showAlert("success", "Salary verified and paid!");

        return { x402, facilitatorProof, verifyResp: verifyResp.data };
      } catch (err: any) {
        addLog({
          level: "error",
          action: "SimulateFacilitator_failed",
          message: err?.message || String(err),
          meta: err,
        });
        showAlert(
          "error",
          "Simulator flow failed: " + (err?.message || "network error")
        );
        return null;
      } finally {
        setStatus(null);
      }
    },
    [showAlert, addLog]
  );

  /* ===========================
     Render
     =========================== */

  return (
    <>
      <Head>
        <title>BlockWage — Employer Dashboard</title>
      </Head>

      <div className="container mx-auto">
        <header className="flex items-center justify-between py-4">
          <div>
            <h1 className="text-3xl font-bold">
              BlockWage — Employer Dashboard
            </h1>
            <p className="muted">
              Manage payroll, assign employees, and trigger pay
            </p>
          </div>
          <div className="text-right">
            <div className="muted">
              RPC:{" "}
              {process.env.NEXT_PUBLIC_RPC_URL || "Cronos testnet (default)"}
            </div>
            <div className="mono mt-1">
              {(wallet as any)?.address
                ? short((wallet as any).address)
                : "Not connected"}
            </div>
          </div>
        </header>

        {/* Alert */}
        {alert && (
          <div
            className={clsx(
              "p-3 rounded mb-4",
              alert.type === "error"
                ? "bg-red-50 text-red-700"
                : alert.type === "success"
                ? "bg-green-50 text-green-700"
                : "bg-blue-50 text-blue-700"
            )}
          >
            {alert.text}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          <section className="card">
            <h2 className="text-xl font-semibold mb-2">Assign Employee</h2>
            <form
              onSubmit={(e) => assignEmployeeHandler(e)}
              className="space-y-3"
            >
              <div>
                <label className="label">Employee address</label>
                <input
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    assignErrors.addr && "border-red-400"
                  )}
                  value={assignAddr}
                  onChange={(e) => setAssignAddr(e.target.value)}
                />
                {assignErrors.addr && (
                  <div className="text-sm text-red-600 mt-1">
                    {assignErrors.addr}
                  </div>
                )}
              </div>

              <div>
                <label className="label">Salary (token units)</label>
                <input
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    assignErrors.salary && "border-red-400"
                  )}
                  value={assignSalary}
                  onChange={(e) => setAssignSalary(e.target.value)}
                />
                {assignErrors.salary && (
                  <div className="text-sm text-red-600 mt-1">
                    {assignErrors.salary}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label">Cadence</label>
                  <select
                    className="input w-full border rounded px-3 py-2"
                    value={assignCadence}
                    onChange={(e) => setAssignCadence(Number(e.target.value))}
                  >
                    <option value={3}>Monthly</option>
                    <option value={2}>Biweekly</option>
                    <option value={1}>Hourly</option>
                    <option value={0}>Minute</option>
                  </select>
                  {assignErrors.cadence && (
                    <div className="text-sm text-red-600 mt-1">
                      {assignErrors.cadence}
                    </div>
                  )}
                </div>

                <div style={{ minWidth: 180 }}>
                  <label className="label">Initial lastPaid (unix)</label>
                  <input
                    type="number"
                    className={clsx(
                      "input w-full border rounded px-3 py-2",
                      assignErrors.lastPaid && "border-red-400"
                    )}
                    value={assignLastPaid}
                    onChange={(e) => setAssignLastPaid(Number(e.target.value))}
                  />
                  {assignErrors.lastPaid && (
                    <div className="text-sm text-red-600 mt-1">
                      {assignErrors.lastPaid}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 mt-2">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!(wallet as any)?.address}
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
                    setAssignErrors({});
                  }}
                >
                  Reset
                </button>
              </div>
            </form>
          </section>

          <section className="card">
            <h2 className="text-xl font-semibold mb-2">Funding & Trigger</h2>

            <form onSubmit={(e) => depositHandler(e)} className="space-y-3">
              <div>
                <label className="label">Period ID (unix integer)</label>
                <input
                  value={depositPeriodId}
                  onChange={(e) => setDepositPeriodId(e.target.value)}
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    depositErrors.periodId && "border-red-400"
                  )}
                />
                {depositErrors.periodId && (
                  <div className="text-sm text-red-600 mt-1">
                    {depositErrors.periodId}
                  </div>
                )}
              </div>

              <div>
                <label className="label">Amount</label>
                <input
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    depositErrors.amount && "border-red-400"
                  )}
                />
                {depositErrors.amount && (
                  <div className="text-sm text-red-600 mt-1">
                    {depositErrors.amount}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!(wallet as any)?.address}
                >
                  Deposit for period
                </button>

                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setDepositAmount("1");
                    setDepositPeriodId(String(Math.floor(Date.now() / 1000)));
                    setDepositErrors({});
                  }}
                >
                  Reset
                </button>
              </div>
            </form>

            <div className="hr my-4" />

            <form onSubmit={(e) => triggerHandler(e)} className="space-y-3">
              <div>
                <label className="label">Employee address to trigger</label>
                <input
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    triggerErrors.employee && "border-red-400"
                  )}
                  value={triggerEmployee}
                  onChange={(e) => setTriggerEmployee(e.target.value)}
                />
                {triggerErrors.employee && (
                  <div className="text-sm text-red-600 mt-1">
                    {triggerErrors.employee}
                  </div>
                )}
              </div>

              <div>
                <label className="label">Period ID</label>
                <input
                  className={clsx(
                    "input w-full border rounded px-3 py-2",
                    triggerErrors.periodId && "border-red-400"
                  )}
                  value={triggerPeriodId}
                  onChange={(e) => setTriggerPeriodId(e.target.value)}
                />
                {triggerErrors.periodId && (
                  <div className="text-sm text-red-600 mt-1">
                    {triggerErrors.periodId}
                  </div>
                )}
              </div>

              <div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!(wallet as any)?.address}
                >
                  Trigger SalaryDue
                </button>
              </div>
            </form>
          </section>
        </div>

        {/* Lookup */}
        <section className="card mt-6">
          <h2 className="text-xl font-semibold mb-2">
            Employee lookup & Claim viewer
          </h2>
          <div className="flex gap-3 mb-3">
            <input
              placeholder="0x..."
              value={lookupAddress}
              onChange={(e) => setLookupAddress(e.target.value)}
              className="input flex-1 border rounded px-3 py-2"
            />
            <button
              className="btn btn-primary"
              onClick={() => {
                addLog({
                  level: "debug",
                  action: "FetchEmployee_clicked",
                  message: "click",
                });
                refreshEmployee();
              }}
              disabled={!lookupAddress}
            >
              Fetch Employee
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                addLog({
                  level: "debug",
                  action: "SimulateFromLookup_clicked",
                  message: "click",
                });
                simulateFacilitatorForClaim(lookupAddress);
              }}
              disabled={!lookupAddress}
            >
              Simulate Facilitator
            </button>
          </div>

          {lookupError && (
            <div className="text-sm text-red-600 mb-3">{lookupError}</div>
          )}

          {employeeInfo ? (
            <div>
              <div className="grid md:grid-cols-3 gap-3">
                <div>
                  <div className="label">Employee</div>
                  <div className="mono">{lookupAddress}</div>
                </div>
                <div>
                  <div className="label">Assigned salary (raw)</div>
                  <div className="mono">{employeeInfo.salary}</div>
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

              <div className="mt-4 x402-instructions">
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

                <div className="mt-3">
                  <p className="muted">
                    Use a facilitator to perform the payment and then POST the
                    proof to your backend /salary/verify endpoint to finalize
                    on-chain release.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="muted">
              No employee loaded. Enter an address and click "Fetch Employee".
            </div>
          )}
        </section>

        {/* Events & logs */}
        <div className="grid md:grid-cols-2 gap-6 mt-6">
          <section className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Recent SalaryDue Events</h3>
              <div>
                <button
                  className="btn btn-ghost mr-2"
                  onClick={() => {
                    fetchEvents();
                    addLog({
                      level: "debug",
                      action: "EventsRefresh_clicked",
                      message: "manual refresh",
                    });
                  }}
                >
                  Refresh
                </button>
              </div>
            </div>

            {loadingEvents ? (
              <div>Loading events...</div>
            ) : events.length === 0 ? (
              <div className="muted">No recent events found.</div>
            ) : (
              <table className="table mt-2">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Amount</th>
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
                      <td className="mono">{ev.periodId}</td>
                      <td>
                        <a
                          className="mono underline"
                          target="_blank"
                          rel="noreferrer"
                          href={`https://testnet.cronoscan.com/tx/${ev.txHash}`}
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
          </section>

          <section className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Action Log</h3>
              <div className="muted text-sm">{logs.length} recent</div>
            </div>

            <div style={{ maxHeight: 380, overflow: "auto" }}>
              <ul className="text-sm space-y-2">
                {logs.map((l, idx) => (
                  <li
                    key={idx}
                    className={clsx(
                      "p-2 rounded",
                      l.level === "error"
                        ? "bg-red-50 text-red-700"
                        : l.level === "debug"
                        ? "bg-slate-50 text-slate-800"
                        : "bg-green-50 text-green-700"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="mono">
                          {new Date(l.ts).toLocaleString()}
                        </div>
                        <div className="font-semibold">{l.action}</div>
                        {l.message && <div className="muted">{l.message}</div>}
                      </div>
                      <div className="text-xs mono">{l.level}</div>
                    </div>
                    {l.meta && (
                      <pre className="mt-2 p-2 bg-white rounded text-xs overflow-x-auto">
                        {JSON.stringify(l.meta, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-2 flex gap-2">
              <button className="btn btn-ghost" onClick={() => clearLogs()}>
                Clear logs
              </button>
            </div>
          </section>
        </div>

        <div className="mt-6 muted">Status: {status ?? "idle"}</div>
      </div>
    </>
  );
}
