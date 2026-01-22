/**
 * Validation utilities for the BlockWage frontend.
 *
 * This file centralizes the small validation helpers and form validators
 * so they can be reused across pages and components.
 *
 * Note: This module depends on `ethers` for address validation. The rest
 * of the helpers are pure functions and have no runtime side-effects.
 */

import { ethers } from "ethers";

/* ---------- Types ---------- */

export type ErrorMap = Record<string, string>;

export type AssignForm = {
  addr: string;
  salary: string;
  cadence: number;
  lastPaid?: number;
};

export type DepositForm = {
  periodId: string;
  amount: string;
};

export type TriggerForm = {
  employee: string;
  periodId: string;
};

/* ---------- Basic validators ---------- */

/**
 * Returns true when `addr` is a syntactically valid EVM address.
 */
export function isValidAddress(addr: string): boolean {
  if (!addr || typeof addr !== "string") return false;
  try {
    // ethers v6 exposes `isAddress` at top-level; v5 would be `ethers.utils.isAddress`
    // We keep the same call pattern used in the app.
    return ethers.isAddress(addr);
  } catch {
    return false;
  }
}

/**
 * True if `val` is a positive number string (allows decimals).
 * Examples: "1", "0.5", "10.00" -> true
 *           "", "0", "-1", "abc" -> false
 */
export function isPositiveNumberString(val: string): boolean {
  if (!val || typeof val !== "string") return false;
  if (!/^[0-9]*\.?[0-9]+$/.test(val)) return false;
  const n = Number(val);
  return !Number.isNaN(n) && n > 0;
}

/**
 * True if `val` is a non-negative integer string.
 * Examples: "0", "123" -> true
 *           "-1", "1.5", "abc", "" -> false
 */
export function isIntegerString(val: string): boolean {
  if (!val || typeof val !== "string") return false;
  if (!/^\d+$/.test(val)) return false;
  const n = Number(val);
  return Number.isInteger(n) && n >= 0;
}

/* ---------- Form validators ---------- */

/**
 * Validate the assign-employee form.
 * Returns an object mapping field names to error messages (empty if valid).
 */
export function validateAssignForm(form: AssignForm): ErrorMap {
  const errs: ErrorMap = {};

  if (!form.addr) errs.addr = "Employee address is required.";
  else if (!isValidAddress(form.addr)) errs.addr = "Invalid address format.";

  if (!form.salary) errs.salary = "Salary is required.";
  else if (!isPositiveNumberString(form.salary))
    errs.salary = "Salary must be a positive number.";

  // allowed cadence values: 0 (hourly), 1 (biweekly), 2 (monthly)
  if (![0, 1, 2].includes(form.cadence))
    errs.cadence = "Invalid cadence selected.";

  if (typeof form.lastPaid !== "undefined") {
    if (!Number.isInteger(form.lastPaid) || form.lastPaid < 0)
      errs.lastPaid = "lastPaid must be a non-negative integer.";
  }

  return errs;
}

/**
 * Validate the deposit form.
 * Returns an object mapping field names to error messages (empty if valid).
 */
export function validateDepositForm(form: DepositForm): ErrorMap {
  const errs: ErrorMap = {};

  if (!form.periodId) errs.periodId = "Period ID is required.";
  else if (!isIntegerString(form.periodId))
    errs.periodId = "Period ID must be a non-negative integer.";

  if (!form.amount) errs.amount = "Amount is required.";
  else if (!isPositiveNumberString(form.amount))
    errs.amount = "Amount must be a positive number.";

  return errs;
}

/**
 * Validate the trigger form.
 * Returns an object mapping field names to error messages (empty if valid).
 */
export function validateTriggerForm(form: TriggerForm): ErrorMap {
  const errs: ErrorMap = {};

  if (!form.employee) errs.employee = "Employee address is required.";
  else if (!isValidAddress(form.employee))
    errs.employee = "Invalid address format.";

  if (!form.periodId) errs.periodId = "Period ID is required.";
  else if (!isIntegerString(form.periodId))
    errs.periodId = "Period ID must be a non-negative integer.";

  return errs;
}

/* ---------- Small helpers ---------- */

/**
 * Convert an ErrorMap into a single human-friendly string message.
 * Joins messages with a space. Useful for toast/alert display.
 */
export function errorMapToMessage(errs: ErrorMap): string {
  return Object.values(errs).join(" ");
}
