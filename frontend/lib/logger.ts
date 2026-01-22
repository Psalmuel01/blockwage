/**
 * Lightweight logging utilities for the BlockWage frontend.
 *
 * Exports:
 * - types: LogLevel, LogEntry
 * - InMemoryLogger: a simple in-memory logger instance (non-react)
 * - useLogger: React hook for component-local logging state
 * - createLogger: convenience factory for InMemoryLogger
 *
 * The module mirrors logs to the browser console for easier debugging and
 * keeps recent entries in memory (for display in debug panels).
 */

import { useCallback, useState } from "react";

/* ---------- Types ---------- */

export type LogLevel = "info" | "error" | "debug";

export type LogEntry = {
  ts: number; // epoch ms
  level: LogLevel;
  action: string;
  message?: string;
  meta?: any;
};

/* ---------- Helpers ---------- */

function nowTs(): number {
  return Date.now();
}

function defaultConsoleForward(entry: LogEntry) {
  const prefix = `[${new Date(entry.ts).toISOString()}] ${entry.action}:`;
  if (entry.level === "error") {
    // Keep meta visible for easier debugging
    // eslint-disable-next-line no-console
    console.error(prefix, entry.message ?? "", entry.meta ?? "");
  } else if (entry.level === "debug") {
    // eslint-disable-next-line no-console
    console.debug(prefix, entry.message ?? "", entry.meta ?? "");
  } else {
    // eslint-disable-next-line no-console
    console.info(prefix, entry.message ?? "", entry.meta ?? "");
  }
}

/* ---------- In-memory logger (non-react) ---------- */

/**
 * Simple in-memory logger useful outside React components or for
 * application-level logging state.
 */
export class InMemoryLogger {
  private maxEntries: number;
  private logs: LogEntry[];
  private onChange?: (logs: LogEntry[]) => void;
  private consoleForward: (entry: LogEntry) => void;

  constructor(opts?: {
    maxEntries?: number;
    initial?: LogEntry[];
    onChange?: (logs: LogEntry[]) => void;
    consoleForward?: (entry: LogEntry) => void;
  }) {
    this.maxEntries = opts?.maxEntries ?? 200;
    this.logs = opts?.initial
      ? [...opts.initial].slice(0, this.maxEntries)
      : [];
    this.onChange = opts?.onChange;
    this.consoleForward = opts?.consoleForward ?? defaultConsoleForward;
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
    this.onChange?.(this.getLogs());
  }

  add(entry: Omit<LogEntry, "ts">) {
    const e: LogEntry = { ts: nowTs(), ...entry };
    this.logs = [e, ...this.logs].slice(0, this.maxEntries);
    try {
      this.consoleForward(e);
    } catch {
      // ignore console-forward errors
    }
    this.onChange?.(this.getLogs());
    return e;
  }

  setOnChange(cb?: (logs: LogEntry[]) => void) {
    this.onChange = cb;
  }
}

/* ---------- React hook (component-local logger) ---------- */

/**
 * useLogger
 * Returns { logs, addLog, clearLogs }.
 *
 * - logs: LogEntry[] (most recent first)
 * - addLog: (entry) => LogEntry
 * - clearLogs: () => void
 *
 * Example:
 * const { logs, addLog } = useLogger();
 * addLog({ level: 'info', action: 'Clicked', message: 'button' });
 */
export function useLogger(initial: LogEntry[] = [], maxEntries = 200) {
  const [logs, setLogs] = useState<LogEntry[]>(() =>
    initial ? [...initial].slice(0, maxEntries) : []
  );

  const addLog = useCallback(
    (entry: Omit<LogEntry, "ts">) => {
      const e: LogEntry = { ts: nowTs(), ...entry };
      setLogs((prev) => {
        const next = [e, ...prev].slice(0, maxEntries);
        return next;
      });

      try {
        defaultConsoleForward(e);
      } catch {
        // ignore console errors in constrained environments
      }

      return e;
    },
    [maxEntries]
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return { logs, addLog, clearLogs } as const;
}

/* ---------- Convenience factory ---------- */

/**
 * createLogger - convenience wrapper creating an InMemoryLogger
 */
export function createLogger(opts?: {
  maxEntries?: number;
  initial?: LogEntry[];
  onChange?: (logs: LogEntry[]) => void;
  consoleForward?: (entry: LogEntry) => void;
}) {
  return new InMemoryLogger(opts);
}
