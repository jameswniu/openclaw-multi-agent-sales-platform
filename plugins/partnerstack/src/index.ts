// Entry point of the PartnerStack plugin for the OpenClaw gateway (the server that runs the agents).
// It registers read tools and money-write tools. A write is offered only to a person whose role holds a
// grant, a written permission in config/permissions.json checked by the shared permission guard in
// plugins/policy-core. Each write also waits for human approval, is claimed in the ledger (ledger.ts)
// under an idempotency key before it is sent, and is never re-sent when its outcome is unknown.
// The backend is the mock in backend.ts unless the plugin config sets backend to "http".

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildJsonPluginConfigSchema,
  jsonResult,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import {
  AbortedBeforeSendError,
  BudgetExceededError,
  BudgetStateError,
  canonicalBaseUrl,
  ConflictError,
  createApi,
  createHttpTransport,
  createLimiter,
  createMockBackend,
  DuplicateInFlightError,
  LockError,
  metadataProblem,
  METADATA_MAX_ATTRIBUTES,
  PartnerStackError,
  PolicyError,
  ProtocolError,
  RateLimitedError,
  UnresolvedWriteError,
  withFileLock,
  type CreateTransactionInput,
  type Limiter,
  type MetadataValue,
  type PartnerStackApi,
  type Reward,
  type Transaction,
  type Transport,
} from "./backend.js";
import { authorizationFor, canonical, createLedger, decisionFor, idemKey, lastRow, latestByIdem, sha256, type Ledger, type LedgerRow } from "./ledger.js";
import { guardWrite, loadPolicy } from "openclaw-policy-core";
import type { Grant, Policy, Principal } from "openclaw-policy-core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const configSchema = Type.Object(
  {
    backend: Type.Optional(Type.Union([Type.Literal("mock"), Type.Literal("http")], { description: "mock keeps everything in memory (default); http calls PartnerStack." })),
    baseUrl: Type.Optional(Type.String({ description: "Vendor API base URL. Default https://api.partnerstack.com/api/v2" })),
    authMode: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("bearer")], { description: "basic (Vendor API, default) or bearer (Partner API)." })),
    publicKey: Type.Optional(Type.String({ description: "Basic auth username. Falls back to PARTNERSTACK_PUBLIC_KEY." })),
    secretKey: Type.Optional(Type.String({ description: "Basic auth password. Falls back to PARTNERSTACK_SECRET_KEY." })),
    apiKey: Type.Optional(Type.String({ description: "Bearer token. Falls back to PARTNERSTACK_API_KEY." })),
    maxRequestsPerMinute: Type.Optional(Type.Integer({ minimum: 1, description: "Local pace in any rolling 60 seconds, well under the documented 4000 per minute per IP. Default 600." })),
    dailyCallBudget: Type.Optional(Type.Integer({ minimum: 1, description: "Daily call cap for this gateway. The docs publish no number; default 5000 is an assumption." })),
    maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum in-flight PartnerStack requests. Default 4." })),
    requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, description: "Deadline for one HTTP request. Default 15000." })),
    maxWriteCents: Type.Optional(Type.Integer({ minimum: 1, description: "Largest reward or transaction amount an agent may create, in cents. Default 100000." })),
    allowedTargets: Type.Optional(
      Type.Array(Type.Union([Type.Literal("customer"), Type.Literal("transaction"), Type.Literal("manual")]), {
        description: "Reward target types agents may create. Default customer and transaction, never manual.",
      }),
    ),
    approvalTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, description: "How long a money write waits for a human decision before it is denied. Default 120000." })),
    inflightWindowMs: Type.Optional(
      Type.Integer({ minimum: 1000, description: "How long a sent-but-unconfirmed write is reported as in flight rather than unresolved. Neither is ever re-sent automatically. Default 60000." }),
    ),
    ledgerDir: Type.Optional(Type.String({ description: "Directory for the append-only ledger and the daily budget counter. Default <OPENCLAW_STATE_DIR>/partnerstack." })),
    permissionsPath: Type.Optional(Type.String({ description: "Passed to the policy seam (openclaw-policy-core). Default config/permissions.json." })),
    usersPath: Type.Optional(Type.String({ description: "Passed to the policy seam (openclaw-policy-core). Default config/users.json." })),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof configSchema>;

export type ResolvedConfig = Required<Omit<Config, "publicKey" | "secretKey" | "apiKey">> & Pick<Config, "publicKey" | "secretKey" | "apiKey">;

export function resolveConfig(raw: Record<string, unknown> | undefined): ResolvedConfig {
  const c = (raw ?? {}) as Config;
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? ".openclaw-home/state";
  return {
    backend: c.backend ?? "mock",
    baseUrl: canonicalBaseUrl(c.baseUrl ?? "https://api.partnerstack.com/api/v2"),
    authMode: c.authMode ?? "basic",
    publicKey: c.publicKey ?? process.env.PARTNERSTACK_PUBLIC_KEY,
    secretKey: c.secretKey ?? process.env.PARTNERSTACK_SECRET_KEY,
    apiKey: c.apiKey ?? process.env.PARTNERSTACK_API_KEY,
    maxRequestsPerMinute: c.maxRequestsPerMinute ?? 600,
    dailyCallBudget: c.dailyCallBudget ?? 5000,
    maxConcurrent: c.maxConcurrent ?? 4,
    requestTimeoutMs: c.requestTimeoutMs ?? 15_000,
    maxWriteCents: c.maxWriteCents ?? 100_000,
    allowedTargets: c.allowedTargets ?? ["customer", "transaction"],
    approvalTimeoutMs: c.approvalTimeoutMs ?? 120_000,
    inflightWindowMs: c.inflightWindowMs ?? 60_000,
    ledgerDir: c.ledgerDir ?? `${stateDir}/partnerstack`,
    permissionsPath: c.permissionsPath ?? "config/permissions.json",
    usersPath: c.usersPath ?? "config/users.json",
  };
}

/** Where a write lands. Part of every idempotency key so a mock result can never satisfy an http write, nor one account another. The base URL is already canonical. */
export function writeNamespace(cfg: ResolvedConfig): string {
  if (cfg.backend !== "http") return "mock";
  const account = cfg.authMode === "basic" ? `basic:${cfg.publicKey ?? ""}` : `bearer:${sha256(cfg.apiKey ?? "").slice(0, 12)}`;
  return `http|${cfg.baseUrl}|${account}`;
}

// ---------------------------------------------------------------------------
// Policy seam: the permission model's package (openclaw-policy-core) is the
// only place a person is resolved. This plugin never reads sender fields itself.
// ---------------------------------------------------------------------------

export type { Grant, Policy, Principal } from "openclaw-policy-core";

export type GuardMeta = { principal: Principal; grant: Grant; toolCallId: string; signal?: AbortSignal; onUpdate?: unknown };

/** The two calls this plugin makes into the permission model. Typed by the real package, so a test stand-in must meet the same contract. */
export type PolicySeam = { loadPolicy: typeof loadPolicy; guardWrite: typeof guardWrite };

/** The real permission model, used unless a test injects a stand-in. A file dependency on ../policy-core, copied in at install time. */
export const policyCore: PolicySeam = { loadPolicy, guardWrite };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const pageProps = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250, description: "Items per page, 1 to 250. Default 10." })),
  starting_after: Type.Optional(Type.String({ description: "Cursor: the key of the last item of the previous page." })),
};

const rewardParams = Type.Object({
  amount: Type.Integer({ minimum: 1, maximum: 100_000_000, description: "Reward amount in cents." }),
  currency: Type.Optional(Type.String({ description: "Three-letter ISO currency, default USD." })),
  description: Type.String({ minLength: 1, description: "What the reward is for. The gateway appends the agent, the person and the idempotency key." }),
  target: Type.Object({
    type: Type.Union([Type.Literal("customer"), Type.Literal("transaction"), Type.Literal("manual")]),
    key: Type.String({ description: "Customer key (cust_...), transaction key or partnership key." }),
  }),
});

const metadataValue = Type.Union([Type.String(), Type.Number(), Type.Null()]);

const transactionParams = Type.Object({
  key: Type.Optional(Type.String({ minLength: 4, maxLength: 255, description: "Client transaction key, the idempotency handle. Derived from the request when omitted." })),
  amount: Type.Integer({ minimum: 1, description: "Transaction amount in cents." }),
  currency: Type.String({ description: "Three-letter ISO currency." }),
  customer_key: Type.Optional(Type.String()),
  customer_external_key: Type.Optional(Type.String()),
  customer_email: Type.Optional(Type.String()),
  product_key: Type.Optional(Type.String()),
  category_key: Type.Optional(Type.String()),
  metadata: Type.Optional(
    Type.Record(Type.String(), metadataValue, {
      description: "Up to 21 attributes, keys of 1 to 30 letters, digits or underscores, string values of at most 100 characters; the gateway adds four of its own.",
    }),
  ),
});

const deleteTransactionParams = Type.Object({
  transaction_key: Type.String({ description: "Key of the transaction to archive." }),
});

export const READ_TOOLS = [
  "partnerstack_list_partnerships",
  "partnerstack_get_partnership",
  "partnerstack_list_customers",
  "partnerstack_list_rewards",
  "partnerstack_list_transactions",
] as const;
export const WRITE_TOOLS = new Set(["partnerstack_create_reward", "partnerstack_create_transaction", "partnerstack_delete_transaction"]);

/** Attribution added to every write and to every ledger row. */
type Stamp = { agent: string; actor: string; session: string; idem: string };
type Send<R> = { probe: () => Promise<R | undefined>; post: () => Promise<R> };

type WriteSpec<P, R extends { key: string }> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  /** One human-readable line for the approval prompt. */
  summarize: (params: P) => string;
  /** Money-shape checks the model cannot talk its way around. Returns the reason to block, or nothing. */
  shapeReason: (params: P, cfg: ResolvedConfig) => string | undefined;
  send: (api: PartnerStackApi, params: P, stamp: Stamp, signal?: AbortSignal) => Send<R>;
  /** True only when a probed record is the one this exact write asked for, whichever session sent it. Anything else under our key is a conflict, never a success. */
  verify: (candidate: R, params: P, stamp: Stamp) => boolean;
};

const GATEWAY_METADATA_KEYS = 4;
const idemTag = (idem: string): string => `idem=${idem.slice(0, 16)}`;
const whoTag = (stamp: Stamp): string => `agent=${stamp.agent} actor=${stamp.actor}`;
const fullTag = (stamp: Stamp): string => `[${whoTag(stamp)} session=${stamp.session} ${idemTag(stamp.idem)}]`;
const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

const createReward: WriteSpec<Static<typeof rewardParams>, Reward> = {
  name: "partnerstack_create_reward",
  label: "Create Reward",
  description: "Create a PartnerStack reward for a customer or transaction. Moves real money to a partner; every call needs human approval.",
  parameters: rewardParams,
  summarize: (p) => `reward of ${p.amount} ${p.currency ?? "USD"} cents to ${p.target.type} ${p.target.key} for "${p.description}"`,
  shapeReason: (p, cfg) => {
    if (!Number.isInteger(p.amount) || p.amount < 1) return "amount must be a positive integer in cents";
    if (p.amount > cfg.maxWriteCents) return `amount ${p.amount} exceeds the per-write cap of ${cfg.maxWriteCents} cents`;
    if (!cfg.allowedTargets.includes(p.target?.type)) return `reward target type ${String(p.target?.type)} is not allowed (allowed: ${cfg.allowedTargets.join(", ")})`;
    if (typeof p.target?.key !== "string" || !p.target.key.trim()) return "target.key is required";
    if (typeof p.description !== "string" || !p.description.trim()) return "description is required";
    return undefined;
  },
  send: (api, p, stamp, signal) => ({
    probe: async () => (await api.listRewards({ description: idemTag(stamp.idem), limit: 1 }, signal)).items[0],
    post: () => api.createReward({ ...p, description: `${p.description} ${fullTag(stamp)}` }, signal),
  }),
  // The idempotency tag already fixes the parameters, the agent and the person; the session is attribution only and may differ on a retry.
  verify: (candidate, p, stamp) =>
    typeof candidate.description === "string" &&
    candidate.description.includes(`${whoTag(stamp)} session=`) && // anchored, so a longer actor id cannot match a shorter one
    candidate.description.includes(`${idemTag(stamp.idem)}]`) &&
    candidate.amount === p.amount &&
    candidate.currency === (p.currency ?? "USD") &&
    // The mock returns the target; the documented reward object may not, so the comparison applies only when it is present.
    (candidate.target === undefined || (candidate.target.type === p.target.type && candidate.target.key === p.target.key)),
};

const createTransaction: WriteSpec<Static<typeof transactionParams>, Transaction> = {
  name: "partnerstack_create_transaction",
  label: "Create Transaction",
  description: "Record a customer transaction in PartnerStack. Drives partner rewards, so every call needs human approval.",
  parameters: transactionParams,
  summarize: (p) => `transaction of ${p.amount} ${p.currency} cents for customer ${p.customer_key ?? p.customer_external_key ?? p.customer_email ?? "?"}`,
  shapeReason: (p, cfg) => {
    if (!Number.isInteger(p.amount) || p.amount < 1) return "amount must be a positive integer in cents";
    if (p.amount > cfg.maxWriteCents) return `amount ${p.amount} exceeds the per-write cap of ${cfg.maxWriteCents} cents`;
    if ([p.customer_key, p.customer_external_key, p.customer_email].filter(Boolean).length !== 1) return "provide exactly one of customer_key, customer_external_key, customer_email";
    if (typeof p.currency !== "string" || p.currency.length !== 3) return "currency must be a three-letter ISO code";
    if (p.key !== undefined && (typeof p.key !== "string" || p.key.length < 4 || p.key.length > 255)) return "key must be 4 to 255 characters";
    return metadataProblem(p.metadata, METADATA_MAX_ATTRIBUTES - GATEWAY_METADATA_KEYS);
  },
  send: (api, p, stamp, signal) => {
    const key = p.key ?? `ps_${stamp.idem.slice(0, 32)}`;
    const body: CreateTransactionInput = {
      ...p,
      key,
      metadata: {
        ...((p.metadata ?? {}) as Record<string, MetadataValue>),
        ps_agent: clip(stamp.agent, 100),
        ps_actor: clip(stamp.actor, 100),
        ps_session: clip(stamp.session, 100),
        ps_idem: stamp.idem.slice(0, 16),
      },
    };
    return {
      probe: async () => (await api.listTransactions({ transaction_key: key, limit: 1 }, signal)).items[0],
      post: () => api.createTransaction(body, signal),
    };
  },
  verify: (candidate, p, stamp) =>
    candidate.metadata?.ps_idem === stamp.idem.slice(0, 16) &&
    candidate.metadata?.ps_agent === clip(stamp.agent, 100) &&
    candidate.metadata?.ps_actor === clip(stamp.actor, 100) &&
    candidate.amount === p.amount &&
    candidate.currency === p.currency,
};

const deleteTransaction: WriteSpec<Static<typeof deleteTransactionParams>, { key: string; archived: true }> = {
  name: "partnerstack_delete_transaction",
  label: "Delete Transaction",
  description: "Archive a PartnerStack transaction. Reverses partner attribution, so every call needs human approval.",
  parameters: deleteTransactionParams,
  summarize: (p) => `delete transaction ${p.transaction_key}`,
  shapeReason: (p) => (typeof p.transaction_key === "string" && p.transaction_key.trim() ? undefined : "transaction_key is required"),
  send: (api, p, _stamp, signal) => ({
    probe: async () => {
      const found = (await api.listTransactions({ transaction_key: p.transaction_key, include_archived: "true", limit: 1 }, signal)).items[0];
      return found?.archived ? { key: found.key, archived: true as const } : undefined;
    },
    post: () => api.deleteTransaction(p.transaction_key, signal),
  }),
  verify: (candidate, p) => candidate.key === p.transaction_key && candidate.archived === true,
};

const WRITE_SPECS: Array<WriteSpec<never, { key: string }>> = [createReward, createTransaction, deleteTransaction] as never;

const WRITE_ATTEMPTS = 3;
const LEDGER_LOCK = "partnerstack-ledger.lock";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export type PluginDeps = {
  seam?: PolicySeam;
  transport?: Transport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type HookEvent = { toolName: string; params: Record<string, unknown>; toolCallId?: string };
type HookContext = { agentId?: string; sessionKey?: string; sessionId?: string };

export function createPlugin(deps: PluginDeps = {}): OpenClawPluginDefinition {
  return definePluginEntry({
    id: "partnerstack",
    name: "PartnerStack",
    description: "PartnerStack partnerships, customers, rewards and transactions with rate limiting, attribution and human-approved writes.",
    configSchema: buildJsonPluginConfigSchema(configSchema as unknown as Record<string, unknown>),
    register(api: OpenClawPluginApi) {
      const cfg = resolveConfig(api.pluginConfig);
      const now = deps.now ?? (() => Date.now());
      const ledger = createLedger(cfg.ledgerDir);
      const limiter = createLimiter({
        maxRequestsPerMinute: cfg.maxRequestsPerMinute,
        dailyCallBudget: cfg.dailyCallBudget,
        maxConcurrent: cfg.maxConcurrent,
        stateDir: cfg.ledgerDir,
        now,
        sleep: deps.sleep,
        random: deps.random,
      });
      const transport =
        deps.transport ??
        (cfg.backend === "http"
          ? createHttpTransport({
              baseUrl: cfg.baseUrl,
              authMode: cfg.authMode,
              publicKey: cfg.publicKey,
              secretKey: cfg.secretKey,
              apiKey: cfg.apiKey,
              requestTimeoutMs: cfg.requestTimeoutMs,
            })
          : createMockBackend().transport);
      const ps = createApi(transport, limiter);
      const seam = deps.seam ?? policyCore;
      const runtime: WriteRuntime = { cfg, ps, ledger, limiter, now, namespace: writeNamespace(cfg) };

      registerReads(api, ps);
      for (const spec of WRITE_SPECS) {
        api.registerTool((toolContext) => buildWriteTool(spec, toolContext, seam, runtime), { name: spec.name, optional: true });
      }
      api.on("before_tool_call", (event: HookEvent, ctx: HookContext) => policyHook(event, ctx, cfg, ledger, now), { priority: 100 });
    },
  });
}

function registerReads(api: OpenClawPluginApi, ps: PartnerStackApi): void {
  const read = <P extends TSchema>(name: string, label: string, description: string, parameters: P, run: (params: Static<P>, signal?: AbortSignal) => Promise<unknown>): AnyAgentTool =>
    ({ name, label, description, parameters, execute: async (_toolCallId: string, params: Static<P>, signal?: AbortSignal) => jsonResult(await run(params, signal)) }) as AnyAgentTool;
  api.registerTool(read("partnerstack_list_partnerships", "List Partnerships", "List partnerships (partners) in the program, newest first.", Type.Object(pageProps), (p, s) => ps.listPartnerships(p, s)));
  api.registerTool(
    read("partnerstack_get_partnership", "Get Partnership", "Look up one partnership by key.", Type.Object({ key: Type.String({ description: "Partnership key, e.g. psh_2001." }) }), (p, s) => ps.getPartnership(p.key, s)),
  );
  api.registerTool(read("partnerstack_list_customers", "List Customers", "List customers attributed to partners, newest first.", Type.Object(pageProps), (p, s) => ps.listCustomers(p, s)));
  api.registerTool(
    read(
      "partnerstack_list_rewards",
      "List Rewards",
      "List partner rewards, newest first. Filter by description text or reward_key.",
      Type.Object({ ...pageProps, description: Type.Optional(Type.String()), reward_key: Type.Optional(Type.String()) }),
      (p, s) => ps.listRewards(p, s),
    ),
  );
  api.registerTool(
    read(
      "partnerstack_list_transactions",
      "List Transactions",
      "List customer transactions, newest first. Filter by transaction_key or customer_key.",
      Type.Object({ ...pageProps, transaction_key: Type.Optional(Type.String()), customer_key: Type.Optional(Type.String()) }),
      (p, s) => ps.listTransactions(p, s),
    ),
  );
}

/** Money-shape gate plus human approval. The hook context carries no sender, so the person is resolved in the tool factory, never here. */
export function policyHook(event: HookEvent, ctx: HookContext, cfg: ResolvedConfig, ledger: Ledger, now: () => number) {
  if (!WRITE_TOOLS.has(event.toolName)) return undefined;
  const spec = WRITE_SPECS.find((s) => s.name === event.toolName);
  if (!spec) return { block: true, blockReason: `unknown PartnerStack write ${event.toolName}` };
  const reason = spec.shapeReason(event.params as never, cfg);
  if (reason) return { block: true, blockReason: `PartnerStack policy: ${reason}` };
  if (!ctx.agentId) return { block: true, blockReason: "PartnerStack policy: no agent id on this tool call" };
  if (!event.toolCallId) return { block: true, blockReason: "PartnerStack policy: the host supplied no toolCallId, so the approval cannot be bound to the call" };
  const toolCallId = event.toolCallId;
  const paramsHash = sha256(canonical(event.params));
  // A fresh id per prompt. The decision row carries it, so a decision can never be borrowed by a later prompt for the same call id.
  const authId = sha256(`${toolCallId}|${now()}|${paramsHash}|${randomUUID()}`);
  const summary = spec.summarize(event.params as never);
  ledger.append({
    kind: "authorize",
    ts: now(),
    toolCallId,
    authId,
    tool: event.toolName,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    paramsHash,
  });
  return {
    requireApproval: {
      title: `PartnerStack: ${spec.label}`,
      description: `Agent ${ctx.agentId} wants to create a ${summary} (session ${ctx.sessionKey ?? "?"}). This moves real money to a partner.`,
      severity: "critical" as const,
      timeoutMs: cfg.approvalTimeoutMs,
      timeoutBehavior: "deny" as const,
      allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "allow-always" | "deny">,
      pluginId: "partnerstack",
      onResolution: (decision: string) => {
        ledger.append({ kind: "decision", ts: now(), toolCallId, authId, tool: event.toolName, decision });
      },
    },
  };
}

type WriteRuntime = { cfg: ResolvedConfig; ps: PartnerStackApi; ledger: Ledger; limiter: Limiter; now: () => number; namespace: string };

/** Build a money write tool for one run. The seam returns null, so the tool is never offered, unless the person on this run holds a grant for it on this agent. */
function buildWriteTool<P, R extends { key: string }>(spec: WriteSpec<P, R>, toolContext: OpenClawPluginToolContext, seam: PolicySeam, rt: WriteRuntime): AnyAgentTool | null {
  const policy: Policy = seam.loadPolicy({ permissionsPath: rt.cfg.permissionsPath, usersPath: rt.cfg.usersPath });
  return seam.guardWrite<P, typeof spec.parameters>({
    toolContext,
    policy,
    tool: {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      // The request object itself: every top-level key must be in the grant's fields list. Single-record, so no recordCount.
      shape: (params) => ({ fields: params }),
      run: (params, meta: GuardMeta) => {
        if (!meta.principal.user) throw new PolicyError(`${spec.name}: no person resolved for this run; refusing the write`);
        const who: Actor = {
          actor: meta.principal.user,
          agentId: toolContext.agentId ?? meta.principal.agent ?? "",
          session: toolContext.sessionKey ?? "",
          sessionId: toolContext.sessionId,
          role: meta.principal.role,
          surface: meta.principal.surface,
        };
        return runWrite(spec, meta.toolCallId, params, who, rt, meta.signal);
      },
    },
  });
}

type Actor = { actor: string; agentId: string; session: string; sessionId?: string; role: string | null; surface: string };

type Claim<R> = { kind: "done"; result: R } | { kind: "reconcile"; prior: LedgerRow } | { kind: "claimed" };

/**
 * The write path. Bound to the hook's authorization for this exact call and
 * these exact parameters, gated on the decision recorded for that very
 * prompt, deduplicated by idempotency key, claimed in the ledger inside a
 * file lock before anything awaits, probed before any re-send, and never
 * re-sent automatically when an earlier attempt has no authoritative outcome.
 */
async function runWrite<P, R extends { key: string }>(spec: WriteSpec<P, R>, toolCallId: string, params: P, who: Actor, rt: WriteRuntime, signal?: AbortSignal): Promise<R> {
  const paramsHash = sha256(canonical(params));
  const idem = idemKey([rt.namespace, who.agentId, who.actor, spec.name, canonical(params)]);
  const stamp: Stamp = { agent: who.agentId, actor: who.actor, session: who.session, idem };
  const base: Partial<LedgerRow> & { idem: string } = {
    toolCallId,
    tool: spec.name,
    agentId: who.agentId,
    sessionKey: who.session,
    sessionId: who.sessionId,
    surface: who.surface,
    actor: who.actor,
    role: who.role,
    namespace: rt.namespace,
    idem,
  };

  // Snapshot, checks and claim under one lock, so neither this event loop nor another process can interleave.
  const claim: Claim<R> = withFileLock(join(rt.cfg.ledgerDir, LEDGER_LOCK), "ledger claim", () => {
    const rows = rt.ledger.rows(); // one parse; a corrupt tail throws a typed LedgerCorruptError
    const auth = authorizationFor(rows, toolCallId);
    if (!auth || !auth.authId) throw new PolicyError(`no policy-hook authorization recorded for tool call ${toolCallId}; refusing the write`);
    base.authId = auth.authId;
    if (auth.tool !== spec.name) throw new PolicyError(`authorization ${toolCallId} is for ${auth.tool}, not ${spec.name}; refusing the write`);
    if (auth.agentId !== who.agentId) throw new PolicyError(`authorization ${toolCallId} was granted to agent ${auth.agentId}, not ${who.agentId}; refusing the write`);
    if ((auth.sessionKey ?? "") !== (who.session ?? "")) throw new PolicyError(`authorization ${toolCallId} belongs to session ${auth.sessionKey ?? "?"}, not ${who.session || "?"}; refusing the write`);
    if ((auth.sessionId ?? "") !== (who.sessionId ?? "")) throw new PolicyError(`authorization ${toolCallId} belongs to a different session id; refusing the write`);
    if (auth.paramsHash !== paramsHash) throw new PolicyError(`parameters of tool call ${toolCallId} changed after approval; refusing the write`);
    const reason = spec.shapeReason(params, rt.cfg);
    if (reason) throw new PolicyError(`PartnerStack policy: ${reason}`);
    const decision = decisionFor(rows, auth.authId)?.decision;
    if (decision !== "allow-once" && decision !== "allow-always") throw new PolicyError(`tool call ${toolCallId} has no recorded approval for this prompt (${decision ?? "pending"}); refusing the write`);
    // One approval funds one intent. The first claim binds the authorization to this person and key; any other binding is refused.
    const consumed = lastRow(rows, (row) => row.authId === auth.authId && (row.kind === "sent" || row.kind === "ok" || row.kind === "failed"));
    if (consumed && (consumed.idem !== idem || consumed.actor !== who.actor)) {
      throw new PolicyError(`approval for tool call ${toolCallId} was already used for a different person or intent; refusing the write`);
    }
    if (signal?.aborted) throw new AbortedBeforeSendError();

    const prior = latestByIdem(rows, idem);
    if (prior?.kind === "ok") return { kind: "done", result: prior.result as R };
    if (prior && !(prior.kind === "failed" && prior.outcome === "rejected")) {
      // Sent and never confirmed, or failed without an authoritative answer: the write may have landed. Probe once outside the lock, never re-send.
      if (prior.kind === "sent" && rt.now() - prior.ts < rt.cfg.inflightWindowMs) throw new DuplicateInFlightError(idem);
      return { kind: "reconcile", prior };
    }
    // No prior attempt, or PartnerStack rejected the last one. Claim the intent here, before anything awaits.
    rt.ledger.append({ kind: "sent", ts: rt.now(), ...base, paramsHash });
    return { kind: "claimed" };
  });

  const send = spec.send(rt.ps, params, stamp, signal);
  if (claim.kind === "done") return claim.result;
  if (claim.kind === "reconcile") {
    const found = await probeOwn(spec, send, params, stamp);
    if (found) {
      rt.ledger.append({ kind: "ok", ts: rt.now(), ...base, key: found.key, result: found });
      return found;
    }
    throw new UnresolvedWriteError(idem, claim.prior.kind, claim.prior.ts);
  }
  try {
    const result = await sendWithBackoff(spec, send, params, stamp, rt.limiter, signal);
    rt.ledger.append({ kind: "ok", ts: rt.now(), ...base, key: result.key, result });
    return result;
  } catch (error) {
    rt.ledger.append({ kind: "failed", ts: rt.now(), ...base, outcome: classifyFailure(error), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** A write response without a record key is not a success we can act on. It is an unknown outcome. */
function requireKey<R extends { key: string }>(spec: WriteSpec<never, never>, value: R): R {
  if (!value || typeof value !== "object" || typeof value.key !== "string" || !value.key) {
    throw new ProtocolError(`${spec.name}: PartnerStack answered 2xx without a record key; the outcome is unknown`);
  }
  return value;
}

/** Ask PartnerStack for the record under our key and accept it only if it is the one this write asked for. */
async function probeOwn<P, R extends { key: string }>(spec: WriteSpec<P, R>, send: Send<R>, params: P, stamp: Stamp): Promise<R | undefined> {
  const candidate = await send.probe();
  if (!candidate) return undefined;
  if (!spec.verify(candidate, params, stamp)) {
    throw new ConflictError(`${spec.name}: PartnerStack already holds a different record under this key (${candidate.key}); refusing to treat it as ours`);
  }
  return requireKey(spec as never, candidate);
}

/** A 429 means the request was rejected before processing, but we still back off and probe before the re-send, so a duplicate can never slip through. */
async function sendWithBackoff<P, R extends { key: string }>(spec: WriteSpec<P, R>, send: Send<R>, params: P, stamp: Stamp, limiter: Limiter, signal?: AbortSignal): Promise<R> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new AbortedBeforeSendError();
    try {
      return requireKey(spec as never, await send.post());
    } catch (error) {
      if (!(error instanceof RateLimitedError) || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      await limiter.wait(limiter.backoffMs(attempt, error.retryAfterMs), signal);
      const found = await probeOwn(spec, send, params, stamp);
      if (found) return found;
    }
  }
}

/** rejected: PartnerStack answered and did not apply the write, or it never left this process. unknown: it may have landed. */
export function classifyFailure(error: unknown): "rejected" | "unknown" {
  if (error instanceof RateLimitedError || error instanceof ConflictError || error instanceof AbortedBeforeSendError || error instanceof LockError) return "rejected";
  if (error instanceof BudgetExceededError || error instanceof BudgetStateError) return "rejected";
  if (error instanceof PartnerStackError && typeof error.status === "number" && error.status < 500) return "rejected";
  return "unknown";
}

const plugin: OpenClawPluginDefinition = createPlugin();

export default plugin;
