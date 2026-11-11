// PartnerStack client for the PartnerStack plugin: typed API shapes, an HTTP transport, a request limiter,
// a file lock, a daily budget counter and an in-memory mock backend.
// PartnerStack is a partner-payments service. Its rewards and transactions move real money.
// The mock backend is the default, so tests and the demo never reach the live service. Only the "http"
// backend does. A ledger is the append-only file in ledger.ts. An idempotency key is a stable id for one
// write, so a repeated request is recognised instead of paid twice.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * PartnerStack Vendor API v2, the parts this plugin touches.
 *
 * Shapes follow the public docs, not a live account:
 *   envelope, pagination, epoch ms    https://docs.partnerstack.com/docs/partner-api
 *   Basic auth public:secret          https://docs.partnerstack.com/reference/auth
 *   Bearer api_key (Partner API)      https://docs.partnerstack.com/reference/partner-api-authentication
 *   4000 requests/min per IP, 429     https://docs.partnerstack.com/reference/rate-limits
 *   GET/POST /v2/rewards              https://docs.partnerstack.com/reference/get_v2-rewards-2
 *                                     https://docs.partnerstack.com/reference/post_v2-rewards
 *   GET/POST/DELETE /v2/transactions  https://docs.partnerstack.com/reference/get_v2-transactions-2
 *                                     https://docs.partnerstack.com/reference/post_v2-transactions
 *                                     https://docs.partnerstack.com/reference/delete_v2-transactions-transaction-key
 *   transaction metadata limits       https://docs.partnerstack.com/reference/transaction-metadata
 *   GET /v2/partnerships              https://docs.partnerstack.com/reference/get_v2-partnerships-2
 *   GET /v2/customers                 https://docs.partnerstack.com/reference/get_v2-customers-2
 */

export type Page<T> = { items: T[]; has_more: boolean };
export type Envelope<T> = { data?: T; message: string; status: number };

export type Partnership = {
  key: string;
  created_at: number;
  updated_at: number;
  email: string;
  name: string;
  claimed: boolean;
  group: { key: string; name: string };
};

export type Customer = {
  key: string;
  created_at: number;
  updated_at: number;
  customer_key: string;
  email: string;
  name: string;
  test: boolean;
};

export type RewardTarget = { type: "customer" | "transaction" | "manual"; key: string };

export type Reward = {
  key: string;
  created_at: number;
  updated_at: number;
  amount: number;
  currency: string;
  description: string;
  reward_status: "hold" | "pending" | "approved" | "declined" | "paid";
  created_by: string;
  creation_source: "manual" | "offer_trigger" | "import" | "drip" | "api_key" | "content_order";
  target: RewardTarget;
};

export type MetadataValue = string | number | null;

export type Transaction = {
  key: string;
  created_at: number;
  updated_at: number;
  amount: number;
  currency: string;
  customer_key: string;
  metadata: Record<string, MetadataValue> | null;
  approved: boolean;
  archived: boolean;
  test: boolean;
  product_key?: string;
  category_key?: string;
};

export type CreateRewardInput = { amount: number; currency?: string; description: string; target: RewardTarget };
export type CreateTransactionInput = {
  key: string;
  amount: number;
  currency: string;
  customer_key?: string;
  customer_external_key?: string;
  customer_email?: string;
  product_key?: string;
  category_key?: string;
  metadata?: Record<string, MetadataValue>;
};

export type ListQuery = Record<string, string | number | undefined>;

export type RequestInput = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: ListQuery;
  body?: unknown;
  signal?: AbortSignal;
};

export type TransportResponse = { status: number; body: Envelope<unknown>; malformed?: boolean; retryAfterMs?: number };
export type Transport = (input: RequestInput) => Promise<TransportResponse>;

// ---------------------------------------------------------------------------
// Errors. Each one is typed so the write path can tell a rejected request
// (safe to send again) from an unknown outcome (never re-sent automatically).
// ---------------------------------------------------------------------------

/** PartnerStack answered with a non-2xx status. */
export class PartnerStackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PartnerStackError";
  }
}

export class RateLimitedError extends PartnerStackError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message, 429);
    this.name = "RateLimitedError";
  }
}

/** A 2xx that did not carry the documented shape. For a write this is an unknown outcome. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** The caller's abort signal fired before the request left this process. Nothing was sent. */
export class AbortedBeforeSendError extends Error {
  constructor() {
    super("PartnerStack request aborted before it was sent");
    this.name = "AbortedBeforeSendError";
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly day: string,
    readonly budget: number,
  ) {
    super(`PartnerStack daily call budget of ${budget} exhausted for ${day} (UTC); reads and writes stop until tomorrow`);
    this.name = "BudgetExceededError";
  }
}

/** The daily counter file is unreadable. Fail closed rather than guess the count. */
export class BudgetStateError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`PartnerStack budget state at ${path} is unusable (${detail}); refusing to guess today's usage`);
    this.name = "BudgetStateError";
  }
}

/** A file lock could not be taken in time. The holder is alive, or unknown, so nothing was stolen. Nothing was sent. */
export class LockError extends Error {
  constructor(
    readonly what: string,
    readonly lockDir: string,
    readonly owner: number | null,
  ) {
    super(`could not take the ${what} lock at ${lockDir} (held by ${owner === null ? "an unknown process" : `pid ${owner}`}); nothing was sent`);
    this.name = "LockError";
  }
}

export class DuplicateInFlightError extends Error {
  constructor(readonly idem: string) {
    super(`an identical PartnerStack write is already in flight (idem ${idem.slice(0, 16)}); not sending it twice`);
    this.name = "DuplicateInFlightError";
  }
}

/** An earlier attempt at this exact write may have landed and PartnerStack does not show it. A person must resolve the ledger row; it is never re-sent automatically. */
export class UnresolvedWriteError extends Error {
  constructor(
    readonly idem: string,
    readonly priorKind: string,
    readonly priorTs: number,
  ) {
    super(
      `an earlier attempt at this exact PartnerStack write (idem ${idem.slice(0, 16)}, ${priorKind} at ${new Date(priorTs).toISOString()}) has no confirmed outcome and the probe found nothing; resolve that ledger row by hand before sending again`,
    );
    this.name = "UnresolvedWriteError";
  }
}

/** PartnerStack already holds a record under our key that is not the one we asked for. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

// ---------------------------------------------------------------------------
// Cross-process file lock. mkdir is atomic on every platform Node supports.
// The holder writes its pid inside; a lock is reclaimed only when that pid is
// dead, never because it is old, so a paused holder is never robbed.
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 3_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function lockOwner(lockDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(lockDir, "owner"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // the holder has taken the directory but not written its pid yet
  }
}

export function withFileLock<T>(lockDir: string, what: string, fn: () => T): T {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = lockOwner(lockDir);
      if (owner !== null && owner !== process.pid && !processAlive(owner)) {
        // Reclaim by atomic rename: only one process can move the dead lock aside, and it deletes the copy it won, never a fresh lock someone else just took.
        const stale = `${lockDir}.stale.${process.pid}.${Date.now()}`;
        try {
          renameSync(lockDir, stale);
        } catch {
          continue; // another process reclaimed it first, or the holder released it
        }
        rmSync(stale, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new LockError(what, lockDir, owner);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Rate limiting and concurrency controls
// ---------------------------------------------------------------------------

export type LimiterOptions = {
  maxRequestsPerMinute: number;
  dailyCallBudget: number;
  maxConcurrent: number;
  /** Directory holding the daily counter file, so a gateway restart does not forget today's usage. */
  stateDir: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type Limiter = {
  /** Run one request under the concurrency cap, the rolling per-minute pace and the daily budget. Reads retry on 429 with backoff; writes never do, the caller probes first. */
  run: <T>(kind: "read" | "write", fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  backoffMs: (attempt: number, retryAfterMs?: number) => number;
  /** Sleep that ends early, with AbortedBeforeSendError, when the signal fires. */
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const BUDGET_FILE = "partnerstack-budget.json";
const READ_RETRY_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const WINDOW_MS = 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function createLimiter(opts: LimiterOptions): Limiter {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const budgetPath = join(opts.stateDir, BUDGET_FILE);

  // In-process concurrency and pace state for this gateway process. Node runs
  // this on one thread and every mutation below happens with no await between
  // check and update, so two tool calls cannot interleave inside it.
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const stamps: number[] = []; // admission times inside the rolling minute

  const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortedBeforeSendError());
      const onAbort = (): void => {
        cleanup();
        reject(new AbortedBeforeSendError());
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });

  /** Take a slot, or queue for one. A caller that aborts while queued leaves the queue and never holds a slot. */
  const acquire = (signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortedBeforeSendError());
      if (inFlight < opts.maxConcurrent) {
        inFlight += 1;
        return resolve();
      }
      const waiter = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new AbortedBeforeSendError());
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const release = (): void => {
    const next = waiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else inFlight -= 1;
  };

  const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const validDay = (day: unknown): day is string => {
    if (typeof day !== "string" || !DAY_PATTERN.test(day)) return false;
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day; // 2026-13-15 parses to NaN and fails closed
  };

  const readBudget = (): { day: string; count: number } | null => {
    if (!existsSync(budgetPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(budgetPath, "utf8"));
    } catch {
      throw new BudgetStateError(budgetPath, "not valid JSON");
    }
    const record = parsed as { day?: unknown; count?: unknown } | null;
    if (!record || !validDay(record.day)) throw new BudgetStateError(budgetPath, "day is not a calendar date");
    if (!Number.isInteger(record.count) || (record.count as number) < 0) throw new BudgetStateError(budgetPath, "count is not a whole number");
    return { day: record.day, count: record.count as number };
  };

  /** Consume one unit of today's budget under the lock, or throw before any request is made. */
  const spendBudget = (): void => {
    mkdirSync(opts.stateDir, { recursive: true });
    withFileLock(`${budgetPath}.lock`, "budget", () => {
      const today = dayOf(now());
      const current = readBudget();
      const count = current && current.day === today ? current.count : 0;
      if (count >= opts.dailyCallBudget) throw new BudgetExceededError(today, opts.dailyCallBudget);
      const tmp = `${budgetPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day: today, count: count + 1 }));
      renameSync(tmp, budgetPath); // atomic replace, a reader never sees a torn file
    });
  };

  /** Rolling window: at most maxRequestsPerMinute admissions in any 60 second span, not per calendar minute. */
  const pace = async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new AbortedBeforeSendError();
      const t = now();
      while (stamps.length > 0 && t - stamps[0] >= WINDOW_MS) stamps.shift();
      if (stamps.length < opts.maxRequestsPerMinute) {
        stamps.push(t);
        return;
      }
      await wait(WINDOW_MS - (t - stamps[0]) + 1, signal);
    }
  };

  const backoffMs = (attempt: number, retryAfterMs?: number): number => {
    const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const jittered = Math.round(exponential * (1 + (random() * 0.2 - 0.1)));
    return Math.max(jittered, retryAfterMs ?? 0);
  };

  const run = async <T>(kind: "read" | "write", fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await acquire(signal);
    try {
      for (let attempt = 0; ; attempt += 1) {
        await pace(signal);
        spendBudget();
        try {
          return await fn();
        } catch (error) {
          if (!(error instanceof RateLimitedError) || kind === "write" || attempt + 1 >= READ_RETRY_ATTEMPTS) throw error;
          await wait(backoffMs(attempt, error.retryAfterMs), signal);
        }
      }
    } finally {
      release();
    }
  };

  return { run, backoffMs, wait };
}

// ---------------------------------------------------------------------------
// HTTP transport (the real API)
// ---------------------------------------------------------------------------

export type HttpTransportOptions = {
  baseUrl: string;
  authMode: "basic" | "bearer";
  publicKey?: string;
  secretKey?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** One spelling of the destination, shared by the transport and the idempotency namespace, so `.../v2` and `.../v2/` are the same account. */
export function canonicalBaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function createHttpTransport(opts: HttpTransportOptions): Transport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = canonicalBaseUrl(opts.baseUrl);
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;
  let authorization: string;
  if (opts.authMode === "basic") {
    if (!opts.publicKey || !opts.secretKey) {
      throw new PartnerStackError("PartnerStack basic auth needs publicKey and secretKey (plugin config or PARTNERSTACK_PUBLIC_KEY / PARTNERSTACK_SECRET_KEY)");
    }
    authorization = `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString("base64")}`;
  } else {
    if (!opts.apiKey) throw new PartnerStackError("PartnerStack bearer auth needs apiKey (plugin config or PARTNERSTACK_API_KEY)");
    authorization = `Bearer ${opts.apiKey}`;
  }
  return async ({ method, path, query, body, signal }) => {
    if (signal?.aborted) throw new AbortedBeforeSendError();
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const text = await response.text();
    let parsed: Envelope<unknown>;
    let malformed = false;
    try {
      parsed = JSON.parse(text) as Envelope<unknown>;
    } catch {
      malformed = true;
      parsed = { message: text.slice(0, 200) || response.statusText, status: response.status };
    }
    return { status: response.status, body: parsed, malformed, retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) };
  };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// ---------------------------------------------------------------------------
// Typed API over a transport, under the limiter
// ---------------------------------------------------------------------------

export type PartnerStackApi = {
  listPartnerships: (query?: ListQuery, signal?: AbortSignal) => Promise<Page<Partnership>>;
  getPartnership: (key: string, signal?: AbortSignal) => Promise<Partnership>;
  listCustomers: (query?: ListQuery, signal?: AbortSignal) => Promise<Page<Customer>>;
  listRewards: (query?: ListQuery, signal?: AbortSignal) => Promise<Page<Reward>>;
  listTransactions: (query?: ListQuery, signal?: AbortSignal) => Promise<Page<Transaction>>;
  createReward: (input: CreateRewardInput, signal?: AbortSignal) => Promise<Reward>;
  createTransaction: (input: CreateTransactionInput, signal?: AbortSignal) => Promise<Transaction>;
  deleteTransaction: (key: string, signal?: AbortSignal) => Promise<{ key: string; archived: true }>;
};

export function createApi(transport: Transport, limiter: Limiter): PartnerStackApi {
  const call = async <T>(kind: "read" | "write", input: RequestInput): Promise<T> => {
    // The 429 becomes an error inside the limiter's loop, so reads retry there and writes surface it to the probe-then-resend path.
    const response = await limiter.run(
      kind,
      async () => {
        const r = await transport(input);
        if (r.status === 429) throw new RateLimitedError(r.body.message || "Too Many Requests", r.retryAfterMs);
        return r;
      },
      input.signal,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new PartnerStackError(`PartnerStack ${input.method} ${input.path} failed: ${response.body.message}`, response.status);
    }
    if (response.malformed || response.body.data === undefined || response.body.data === null) {
      throw new ProtocolError(`PartnerStack ${input.method} ${input.path} answered ${response.status} without the documented JSON data envelope`);
    }
    return response.body.data as T;
  };
  return {
    listPartnerships: (query, signal) => call("read", { method: "GET", path: "/partnerships", query, signal }),
    getPartnership: (key, signal) => call("read", { method: "GET", path: `/partnerships/${encodeURIComponent(key)}`, signal }),
    listCustomers: (query, signal) => call("read", { method: "GET", path: "/customers", query, signal }),
    listRewards: (query, signal) => call("read", { method: "GET", path: "/rewards", query, signal }),
    listTransactions: (query, signal) => call("read", { method: "GET", path: "/transactions", query, signal }),
    createReward: (input, signal) => call("write", { method: "POST", path: "/rewards", body: input, signal }),
    createTransaction: (input, signal) => call("write", { method: "POST", path: "/transactions", body: input, signal }),
    deleteTransaction: (key, signal) => call("write", { method: "DELETE", path: `/transactions/${encodeURIComponent(key)}`, signal }),
  };
}

// ---------------------------------------------------------------------------
// Metadata limits from the docs, shared by the plugin's shape check and the mock
// ---------------------------------------------------------------------------

export const METADATA_MAX_ATTRIBUTES = 25;
export const METADATA_KEY_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
export const METADATA_VALUE_MAX_LENGTH = 100;

/** Returns the first violation of the documented transaction metadata limits, or nothing. */
export function metadataProblem(metadata: unknown, maxAttributes = METADATA_MAX_ATTRIBUTES): string | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  if (typeof metadata !== "object" || Array.isArray(metadata)) return "metadata must be an object";
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > maxAttributes) return `metadata allows at most ${maxAttributes} attributes`;
  for (const [key, value] of entries) {
    if (!METADATA_KEY_PATTERN.test(key)) return `metadata key "${key}" must be 1 to 30 letters, digits or underscores`;
    if (value === null || typeof value === "number") continue;
    if (typeof value !== "string") return `metadata value for "${key}" must be null, a string or a number`;
    if (value.length > METADATA_VALUE_MAX_LENGTH) return `metadata value for "${key}" exceeds ${METADATA_VALUE_MAX_LENGTH} characters`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// In-memory mock of the real API, the way plugins/salesforce fakes Salesforce
// ---------------------------------------------------------------------------

export type RecordedCall = { method: string; path: string; query?: ListQuery; body?: unknown; status: number };

export type MockBackend = {
  transport: Transport;
  calls: RecordedCall[];
  inFlight: number;
  maxObservedInFlight: number;
  /** The next n requests answer 429 with the documented error envelope. */
  rateLimitNext: (n: number) => void;
  /** The next n requests answer 400 with the documented error envelope, a definite rejection. */
  rejectNext: (n: number) => void;
  /** The next n requests answer 200 with a body that is not the JSON envelope. */
  malformedNext: (n: number) => void;
  /** The next n requests answer 200 with an envelope whose data is an empty object. */
  emptyDataNext: (n: number) => void;
  /** The next n requests park until release() is called, to observe concurrency. */
  delayNext: (n: number) => void;
  release: () => void;
  rewards: Map<string, Reward>;
  transactions: Map<string, Transaction>;
};

const T0 = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z in epoch ms, the API's time format
const CURRENCIES = new Set(["USD", "CAD", "EUR", "GBP", "AUD", "SGD"]);

export function createMockBackend(): MockBackend {
  const partnerships = new Map<string, Partnership>([
    ["psh_2001", { key: "psh_2001", created_at: T0, updated_at: T0, email: "amy@harborpartners.example", name: "Harbor Partners", claimed: true, group: { key: "grp_reseller", name: "Resellers" } }],
    ["psh_2002", { key: "psh_2002", created_at: T0 + 1, updated_at: T0 + 1, email: "leo@lumenconsulting.example", name: "Lumen Consulting", claimed: true, group: { key: "grp_referral", name: "Referral" } }],
  ]);
  const customers = new Map<string, Customer>([
    ["cust_1001", { key: "cust_1001", created_at: T0, updated_at: T0, customer_key: "northwind-1001", email: "ops@northwindretail.example", name: "Northwind Retail", test: false }],
    ["cust_1002", { key: "cust_1002", created_at: T0 + 1, updated_at: T0 + 1, customer_key: "beacon-1002", email: "it@beaconlogistics.example", name: "Beacon Logistics", test: false }],
  ]);
  const rewards = new Map<string, Reward>([
    ["rew_3001", { key: "rew_3001", created_at: T0, updated_at: T0, amount: 12000, currency: "USD", description: "10% of first invoice", reward_status: "paid", created_by: "system", creation_source: "offer_trigger", target: { type: "transaction", key: "tr_4001" } }],
    ["rew_3002", { key: "rew_3002", created_at: T0 + 1, updated_at: T0 + 1, amount: 5000, currency: "USD", description: "Referral bonus", reward_status: "pending", created_by: "usr_jordan", creation_source: "manual", target: { type: "customer", key: "cust_1002" } }],
  ]);
  const transactions = new Map<string, Transaction>([
    ["tr_4001", { key: "tr_4001", created_at: T0, updated_at: T0, amount: 120000, currency: "USD", customer_key: "cust_1001", metadata: null, approved: true, archived: false, test: false }],
    ["tr_4002", { key: "tr_4002", created_at: T0 + 1, updated_at: T0 + 1, amount: 48000, currency: "USD", customer_key: "cust_1002", metadata: null, approved: false, archived: false, test: false }],
  ]);
  let seq = 5000;
  let rateLimitBudget = 0;
  let rejectBudget = 0;
  let malformedBudget = 0;
  let emptyDataBudget = 0;
  let delayBudget = 0;
  let parked: Array<() => void> = [];

  const ok = <T>(data: T, message = "OK"): TransportResponse => ({ status: 200, body: { data, message, status: 200 } });
  const fail = (status: number, message: string): TransportResponse => ({ status, body: { message, status } });
  const page = <T extends { key: string; created_at: number }>(store: Map<string, T>, query: ListQuery | undefined, filter: (item: T) => boolean): TransportResponse => {
    const limit = Math.min(250, Math.max(1, Number(query?.limit ?? 10)));
    const sorted = [...store.values()].filter(filter).sort((a, b) => b.created_at - a.created_at);
    let start = 0;
    if (query?.starting_after) {
      const index = sorted.findIndex((item) => item.key === query.starting_after);
      start = index === -1 ? sorted.length : index + 1;
    }
    const items = sorted.slice(start, start + limit);
    return ok({ items, has_more: start + limit < sorted.length }, "Page returned successfully");
  };

  const handle = ({ method, path, query, body }: RequestInput): TransportResponse => {
    if (rateLimitBudget > 0) {
      rateLimitBudget -= 1;
      return fail(429, "Too Many Requests");
    }
    if (rejectBudget > 0) {
      rejectBudget -= 1;
      return fail(400, "rejected by the test backend");
    }
    if (malformedBudget > 0) {
      malformedBudget -= 1;
      return { status: 200, body: { message: "<html>gateway timeout page</html>", status: 200 }, malformed: true };
    }
    if (emptyDataBudget > 0) {
      emptyDataBudget -= 1;
      return ok({}, "OK");
    }
    const [, resource, key] = path.split("/");
    if (method === "GET" && resource === "partnerships" && !key) return page(partnerships, query, () => true);
    if (method === "GET" && resource === "partnerships" && key) {
      const found = partnerships.get(key);
      return found ? ok(found) : fail(404, `partnership ${key} not found`);
    }
    if (method === "GET" && resource === "customers") return page(customers, query, () => true);
    if (method === "GET" && resource === "rewards") {
      return page(rewards, query, (reward) => {
        if (query?.reward_key && reward.key !== query.reward_key) return false;
        if (query?.description && !reward.description.includes(String(query.description))) return false;
        return true;
      });
    }
    if (method === "GET" && resource === "transactions") {
      return page(transactions, query, (tx) => {
        if (query?.transaction_key && tx.key !== query.transaction_key) return false;
        if (query?.customer_key && tx.customer_key !== query.customer_key) return false;
        return !tx.archived || query?.include_archived === "true";
      });
    }
    if (method === "POST" && resource === "rewards") {
      const input = body as Partial<CreateRewardInput>;
      if (!Number.isInteger(input.amount) || (input.amount as number) < 1 || (input.amount as number) > 100_000_000) {
        return fail(400, "amount must be an integer between 1 and 100000000 cents");
      }
      if (!input.description) return fail(400, "description is required");
      if (!input.target || !["customer", "transaction", "manual"].includes(input.target.type) || !input.target.key) return fail(400, "target.type and target.key are required");
      if (input.currency && !CURRENCIES.has(input.currency)) return fail(400, `unsupported currency ${input.currency}`);
      if (input.target.type === "customer" && !customers.has(input.target.key)) return fail(404, `customer ${input.target.key} not found`);
      if (input.target.type === "transaction" && !transactions.has(input.target.key)) return fail(404, `transaction ${input.target.key} not found`);
      const now = T0 + (seq += 1);
      const reward: Reward = {
        key: `rew_${seq}`,
        created_at: now,
        updated_at: now,
        amount: input.amount as number,
        currency: input.currency ?? "USD",
        description: input.description,
        reward_status: "pending",
        created_by: "usr_apikey",
        creation_source: "api_key",
        target: input.target,
      };
      rewards.set(reward.key, reward);
      return ok(reward, "Reward created");
    }
    if (method === "POST" && resource === "transactions") {
      const input = body as Partial<CreateTransactionInput>;
      const refs = [input.customer_key, input.customer_external_key, input.customer_email].filter(Boolean);
      if (refs.length !== 1) return fail(400, "provide exactly one of customer_key, customer_external_key, customer_email");
      if (!Number.isInteger(input.amount) || (input.amount as number) < 1) return fail(400, "amount must be a positive integer in cents");
      if (!input.currency) return fail(400, "currency is required");
      if (input.key && (input.key.length < 4 || input.key.length > 255)) return fail(400, "key must be 4 to 255 characters");
      const metadataIssue = metadataProblem(input.metadata);
      if (metadataIssue) return fail(400, metadataIssue);
      const customer = input.customer_key
        ? customers.get(input.customer_key)
        : [...customers.values()].find((c) => c.customer_key === input.customer_external_key || c.email === input.customer_email);
      if (!customer) return fail(404, "customer not found");
      const now = T0 + (seq += 1);
      const tx: Transaction = {
        key: input.key ?? `tr_${seq}`,
        created_at: now,
        updated_at: now,
        amount: input.amount as number,
        currency: input.currency,
        customer_key: customer.key,
        metadata: input.metadata ?? null,
        approved: false,
        archived: false,
        test: false,
        product_key: input.product_key,
        category_key: input.category_key,
      };
      transactions.set(tx.key, tx);
      return ok(tx, "Transaction created");
    }
    if (method === "DELETE" && resource === "transactions" && key) {
      const tx = transactions.get(key);
      if (!tx || tx.archived) return fail(404, `transaction ${key} not found`);
      transactions.set(key, { ...tx, archived: true, updated_at: T0 + (seq += 1) });
      return ok({ key, archived: true }, "Transaction deleted");
    }
    return fail(404, `no route for ${method} ${path}`);
  };

  const mock: MockBackend = {
    calls: [],
    inFlight: 0,
    maxObservedInFlight: 0,
    rateLimitNext: (n) => void (rateLimitBudget = n),
    rejectNext: (n) => void (rejectBudget = n),
    malformedNext: (n) => void (malformedBudget = n),
    emptyDataNext: (n) => void (emptyDataBudget = n),
    delayNext: (n) => void (delayBudget = n),
    release: () => {
      const waiting = parked;
      parked = [];
      for (const resume of waiting) resume();
    },
    rewards,
    transactions,
    transport: async (input) => {
      if (input.signal?.aborted) throw new AbortedBeforeSendError();
      mock.inFlight += 1;
      mock.maxObservedInFlight = Math.max(mock.maxObservedInFlight, mock.inFlight);
      try {
        if (delayBudget > 0) {
          delayBudget -= 1;
          await new Promise<void>((resolve) => parked.push(resolve));
        }
        const response = handle(input);
        mock.calls.push({ method: input.method, path: input.path, query: input.query, body: input.body, status: response.status });
        return response;
      } finally {
        mock.inFlight -= 1;
      }
    },
  };
  return mock;
}
