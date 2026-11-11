// Append-only JSONL ledger for the PartnerStack plugin. JSONL is one JSON object per line.
// Each row records one event on the write path with the agent, the person it acted for and the
// idempotency key, which is a stable id for one write. A crash between sending and recording can then be
// told apart from a write that never left the process.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Append-only JSONL ledger. One row per event on the write path, so every
 * PartnerStack change can be traced back to the agent, the person it acted
 * for, the tool call and the idempotency key, and so a crash between "sent"
 * and "ok" leaves a row that the next attempt reconciles instead of a silent
 * second send.
 *
 * Every append is fsynced before it returns, so a row that was written before
 * a request left is on disk when the machine comes back. Reads and appends are
 * synchronous on purpose, and the write path runs its snapshot, checks and
 * claim inside one file lock, so neither another tool call on this event loop
 * nor another gateway process sharing the directory can interleave with it.
 */
export type LedgerRow = {
  kind: "authorize" | "decision" | "sent" | "ok" | "failed";
  ts: number;
  toolCallId?: string;
  /** authorize rows carry a fresh id; the decision row for that prompt carries the same id, so a decision can never be borrowed by a later authorization of the same call. */
  authId?: string;
  tool?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  surface?: string;
  actor?: string | null;
  role?: string | null;
  namespace?: string;
  idem?: string;
  paramsHash?: string;
  key?: string;
  result?: unknown;
  error?: string;
  /**
   * failed rows only. rejected: PartnerStack answered and did not apply the
   * write, or it never left this process, so it is safe to send again.
   * unknown: there was no authoritative answer, the write may have landed,
   * and it is never re-sent automatically.
   */
  outcome?: "rejected" | "unknown";
  decision?: string;
};

export const LEDGER_FILE = "partnerstack-ledger.jsonl";

export class LedgerCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
  ) {
    super(`ledger ${path} has an unreadable row at line ${line}; money writes stop until it is repaired by hand`);
    this.name = "LedgerCorruptError";
  }
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Idempotency key: where (backend, account), who (agent, person), what (tool) and exactly which parameters. */
export function idemKey(parts: unknown[]): string {
  return sha256(canonical(parts));
}

export type Ledger = {
  path: string;
  append: (row: LedgerRow) => void;
  /** One parse of the whole file. Throws LedgerCorruptError on an unreadable row, so a torn tail fails closed instead of hiding a claim. */
  rows: () => LedgerRow[];
};

export function createLedger(dir: string): Ledger {
  const path = join(dir, LEDGER_FILE);
  return {
    path,
    append(row) {
      mkdirSync(dir, { recursive: true });
      const fd = openSync(path, "a");
      try {
        writeSync(fd, `${JSON.stringify(row)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    rows() {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, "utf8").split("\n");
      const out: LedgerRow[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        try {
          out.push(JSON.parse(lines[i]) as LedgerRow);
        } catch {
          throw new LedgerCorruptError(path, i + 1);
        }
      }
      return out;
    },
  };
}

export function lastRow(rows: LedgerRow[], pred: (row: LedgerRow) => boolean): LedgerRow | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (pred(rows[i])) return rows[i];
  }
  return undefined;
}

export const authorizationFor = (rows: LedgerRow[], toolCallId: string): LedgerRow | undefined =>
  lastRow(rows, (row) => row.kind === "authorize" && row.toolCallId === toolCallId);

/** The decision recorded for one specific authorization, never for the call id in general. */
export const decisionFor = (rows: LedgerRow[], authId: string): LedgerRow | undefined =>
  lastRow(rows, (row) => row.kind === "decision" && row.authId === authId);

export const latestByIdem = (rows: LedgerRow[], idem: string): LedgerRow | undefined =>
  lastRow(rows, (row) => row.idem === idem && (row.kind === "sent" || row.kind === "ok" || row.kind === "failed"));
