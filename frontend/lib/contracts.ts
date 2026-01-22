/**
 * Vibe Coding/blockwage/frontend/lib/contracts.ts
 *
 * Frontend helpers for interacting with on-chain contracts (ethers v6).
 * - Exports minimal ABIs for SalarySchedule, PayrollVault, PaymentVerifier, and ERC20
 * - Exports helper functions to create contract instances using a Provider or Signer
 *
 * Notes:
 * - Frontend expects contract addresses to be provided via NEXT_PUBLIC_* env vars:
 *    NEXT_PUBLIC_RPC_URL
 *    NEXT_PUBLIC_SALARY_SCHEDULE
 *    NEXT_PUBLIC_PAYROLL_VAULT
 *    NEXT_PUBLIC_PAYMENT_VERIFIER
 *    NEXT_PUBLIC_STABLECOIN
 *
 * - Wallet interactions should be performed by obtaining a signer (via window.ethereum -> BrowserProvider).
 */

import { ethers } from "ethers";

/* =========================
   Environment-driven addresses
   ========================= */
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://evm-t3.cronos.org";
export const SALARY_SCHEDULE_ADDRESS =
  process.env.NEXT_PUBLIC_SALARY_SCHEDULE || "";
export const PAYROLL_VAULT_ADDRESS =
  process.env.NEXT_PUBLIC_PAYROLL_VAULT || "";
export const PAYMENT_VERIFIER_ADDRESS =
  process.env.NEXT_PUBLIC_PAYMENT_VERIFIER || "";
export const STABLECOIN_ADDRESS = process.env.NEXT_PUBLIC_STABLECOIN || "";

/* =========================
   Minimal ABIs (human-readable fragment arrays)
   These are intentionally minimal — expand as needed.
   ========================= */
export const SalaryScheduleABI = [
  // Views
  "function getEmployee(address) view returns (uint256 salary, uint8 cadence, uint256 lastPaid, bool exists)",
  "function nextExpectedPeriod(address) view returns (uint256)",
  "function isDue(address,uint256) view returns (bool,string)",
  // Admin
  "function assignEmployee(address,uint256,uint8,uint256) external",
  "function setPayrollVault(address) external",
  "function triggerSalaryDue(address,uint256) external",
  "function confirmPaid(address,uint256,uint256) external",
  // Events
  "event SalaryDue(address indexed employee, uint256 amount, address token, uint256 periodId)",
  "event EmployeeAssigned(address indexed employee, uint256 salary, uint8 cadence)",
];

export const PayrollVaultABI = [
  // Token interactions & bookkeeping
  "function depositPayroll(uint256 periodId, uint256 amount) external",
  "function withdrawExcess(uint256 amount) external",
  "function releaseSalary(address employee, uint256 periodId) external",
  "function isPaid(address employee, uint256 periodId) view returns (bool)",
  // Views
  "function totalBalance() view returns (uint256)",
  // Events
  "event PayrollDeposited(address indexed from, uint256 indexed periodId, uint256 amount)",
  "event SalaryReleased(address indexed employee, uint256 indexed periodId, uint256 amount, address to)",
];

export const PaymentVerifierABI = [
  "function verifyPayment(bytes calldata facilitatorProof) external returns (bool)",
  "function isVerified(address employee, uint256 periodId) external view returns (bool)",
  "function registerProof(bytes calldata facilitatorProof) external returns (bytes32)",
  "event PaymentVerified(address indexed employee, uint256 indexed periodId, uint256 amount, bytes32 proofHash, address submitter)",
  "event PaymentConsumed(bytes32 indexed proofHash, address indexed consumer)",
];

export const ERC20MinimalABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];

/* =========================
   Types
   ========================= */
type ProviderOrSigner =
  | ethers.Provider
  | ethers.BrowserProvider
  | ethers.JsonRpcProvider
  | ethers.Wallet
  | ethers.Signer;

/* =========================
   Provider / Signer helpers
   ========================= */

/**
 * Get a JSON-RPC provider (read-only) from env RPC_URL.
 */
export function getJsonRpcProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPC_URL);
}

/**
 * Get a browser provider if window.ethereum is available.
 * Returns a BrowserProvider wrapper (ethers v6) which can provide a signer.
 */
export function getBrowserProvider(): ethers.BrowserProvider | null {
  if (typeof window === "undefined") return null;
  const anyWindow = window as any;
  if (!anyWindow.ethereum) return null;
  try {
    return new ethers.BrowserProvider(anyWindow.ethereum);
  } catch (e) {
    console.warn("Failed to create BrowserProvider", e);
    return null;
  }
}

/**
 * Convenience: get signer from browser provider (if available).
 */
export async function getBrowserSigner(): Promise<ethers.Signer | null> {
  const bp = getBrowserProvider();
  if (!bp) return null;
  try {
    // request accounts is done by the app's wallet connect flow; here we simply return signer(0)
    const signer = await bp.getSigner();
    return signer as ethers.Signer;
  } catch (e) {
    console.warn("Unable to get browser signer", e);
    return null;
  }
}

/* =========================
   Contract factories (instances)
   ========================= */

/**
 * Create a SalarySchedule contract instance connected to providerOrSigner.
 * If providerOrSigner is omitted, uses JSON-RPC provider (read-only).
 */
export function getSalaryScheduleContract(providerOrSigner?: ProviderOrSigner) {
  const provider = providerOrSigner ?? getJsonRpcProvider();
  return new ethers.Contract(
    SALARY_SCHEDULE_ADDRESS,
    SalaryScheduleABI,
    provider
  );
}

/**
 * Create a PayrollVault contract instance connected to providerOrSigner.
 */
export function getPayrollVaultContract(providerOrSigner?: ProviderOrSigner) {
  const provider = providerOrSigner ?? getJsonRpcProvider();
  return new ethers.Contract(PAYROLL_VAULT_ADDRESS, PayrollVaultABI, provider);
}

/**
 * Create a PaymentVerifier contract instance connected to providerOrSigner.
 */
export function getPaymentVerifierContract(
  providerOrSigner?: ProviderOrSigner
) {
  const provider = providerOrSigner ?? getJsonRpcProvider();
  return new ethers.Contract(
    PAYMENT_VERIFIER_ADDRESS,
    PaymentVerifierABI,
    provider
  );
}

/**
 * Create an ERC20 contract instance for the configured stablecoin.
 */
export function getStablecoinContract(
  address?: string,
  providerOrSigner?: ProviderOrSigner
) {
  const tokenAddr = address ?? STABLECOIN_ADDRESS;
  const provider = providerOrSigner ?? getJsonRpcProvider();
  return new ethers.Contract(tokenAddr, ERC20MinimalABI, provider);
}

/* =========================
   Small helpers
   ========================= */

/**
 * Safely format a BigNumber amount using token decimals (defaults to 6 for USDC-like).
 * Returns formatted decimal string.
 */
export async function formatTokenAmount(
  amountBN: ethers.BigNumberish,
  tokenAddress?: string,
  provider?: ProviderOrSigner
): Promise<string> {
  try {
    const token = getStablecoinContract(tokenAddress, provider);
    const decimals: number = Number(await token.decimals());
    return ethers.formatUnits(amountBN, decimals);
  } catch (e) {
    // If token decimals not available, assume 6 (USDC) for frontend display
    try {
      return ethers.formatUnits(amountBN, 6);
    } catch {
      return String(amountBN);
    }
  }
}

/**
 * Parse human amount (e.g., "1.5") to BigInt in smallest unit given token decimals (defaults to 6).
 */
export async function parseTokenAmount(
  amountStr: string,
  tokenAddress?: string,
  provider?: ProviderOrSigner
): Promise<bigint> {
  try {
    const token = getStablecoinContract(tokenAddress, provider);
    const decimals: number = Number(await token.decimals());
    return ethers.parseUnits(amountStr, decimals);
  } catch (e) {
    // assume 6 decimals
    return ethers.parseUnits(amountStr, 6);
  }
}

/**
 * Utility: ensure address is present and warn if not configured.
 */
export function ensureAddress(addr: string, name = "contract") {
  if (!addr || addr === "") {
    console.warn(
      `Warning: ${name} address not configured. Check NEXT_PUBLIC_* env variables.`
    );
  }
  return addr;
}

/* =========================
   Exported default helpers
   ========================= */

export default {
  RPC_URL,
  SALARY_SCHEDULE_ADDRESS,
  PAYROLL_VAULT_ADDRESS,
  PAYMENT_VERIFIER_ADDRESS,
  STABLECOIN_ADDRESS,
  getJsonRpcProvider,
  getBrowserProvider,
  getBrowserSigner,
  getSalaryScheduleContract,
  getPayrollVaultContract,
  getPaymentVerifierContract,
  getStablecoinContract,
  formatTokenAmount,
  parseTokenAmount,
};
