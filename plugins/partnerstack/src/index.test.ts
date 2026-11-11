// Vitest suite for the PartnerStack plugin in index.ts. It uses the in-memory mock backend and a stand-in
// policy for the permission guard, so it needs no key and no network. It covers grants, human approval,
// idempotency keys, the ledger, rate limiting and the cases where a write's outcome is unknown.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardWrite, type Policy } from "openclaw-policy-core";
import { createPlugin, configSchema, READ_TOOLS, WRITE_TOOLS, type PolicySeam } from "./index.js";
import {
  BudgetExceededError,
  BudgetStateError,
  ConflictError,
  createMockBackend,
  DuplicateInFlightError,
  PolicyError,
  ProtocolError,
  UnresolvedWriteError,
} from "./backend.js";
import { LedgerCorruptError } from "./ledger.js";

// ---------------------------------------------------------------------------
// The permission model's own guardWrite over an in-memory policy, in the shape
// loadPolicy builds from config/permissions.json and config/users.json: two
// people on the webchat surface, both csm, with a grant per write tool on the
// sales agent. Only the file read is stood in for here; src/integration.test.ts
// drives the same tools through loadPolicy on real files.
// ---------------------------------------------------------------------------

const WRITE_FIELDS: Record<string, string[]> = {
  partnerstack_create_reward: ["amount", "currency", "description", "target"],
  partnerstack_create_transaction: ["key", "amount", "currency", "customer_key", "customer_external_key", "customer_email", "product_key", "category_key", "metadata"],
  partnerstack_delete_transaction: ["transaction_key"],
};

const fakePolicy: Policy = {
  identities: { "webchat:U1": "dana.whitfield@northwind.example", "webchat:U2": "marcus.oyelaran@northwind.example" },
  rolesByEmail: { "dana.whitfield@northwind.example": "csm", "marcus.oyelaran@northwind.example": "csm" },
  grants: { csm: { sales: Object.fromEntries(Object.entries(WRITE_FIELDS).map(([tool, fields]) => [tool, { surfaces: ["webchat"], fields }])) } },
  permissionsPath: "<in-memory>",
  usersPath: "<in-memory>",
};

const fakeSeam: PolicySeam = { loadPolicy: () => fakePolicy, guardWrite };

type Tool = { name: string; execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<{ details: unknown }> };
type Factory = (toolContext: Record<string, unknown>) => Tool | null;
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
type Approval = { requireApproval: { description: string; onResolution: (decision: string) => void } };

/** A controllable clock for the limiter: the fake sleep records the wait and moves time forward by it. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

type Options = { clock?: ReturnType<typeof fakeClock>; sleep?: (ms: number) => Promise<void> };

function registerPlugin(config: Record<string, unknown> = {}, seam: PolicySeam = fakeSeam, options: Options = {}) {
  const backend = createMockBackend();
  const sleeps: number[] = [];
  const ledgerDir = (config.ledgerDir as string | undefined) ?? mkdtempSync(join(tmpdir(), "ps-ledger-"));
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      sleeps.push(ms);
      options.clock?.advance(ms);
    });
  const plugin = createPlugin({ seam, transport: backend.transport, sleep, random: () => 0.5, now: options.clock?.now });
  const tools = new Map<string, Tool>();
  const factories = new Map<string, Factory>();
  const warnings: string[] = [];
  let hook: Hook | undefined;
  if (!plugin.register) throw new Error("plugin has no register");
  plugin.register({
    id: "partnerstack",
    name: "PartnerStack",
    pluginConfig: { backend: "mock", ledgerDir, ...config },
    logger: { info() {}, warn: (m: string) => void warnings.push(m), error() {}, debug() {} },
    registerTool: (tool: Tool | Factory, opts?: { name?: string }) => {
      if (typeof tool === "function") factories.set(opts?.name ?? "", tool);
      else tools.set(tool.name, tool);
    },
    on: (name: string, handler: Hook) => {
      if (name === "before_tool_call") hook = handler;
    },
  } as never);
  if (!hook) throw new Error("before_tool_call hook was not registered");
  const writeTool = (name: string, toolContext: Record<string, unknown>): Tool | null => factories.get(name)!(toolContext);
  return { tools, factories, hook, backend, sleeps, ledgerDir, warnings, writeTool };
}

type Plugin = ReturnType<typeof registerPlugin>;

const salesCtx = { agentId: "sales", sessionKey: "agent:sales:main", sessionId: "s-1", messageChannel: "webchat", requesterSenderId: "U1" };
const hookCtx = { agentId: "sales", sessionKey: "agent:sales:main", sessionId: "s-1" };
const rewardParams = { amount: 2500, currency: "USD", description: "Q3 referral bonus", target: { type: "customer", key: "cust_1001" } };

/** Run the policy hook the way the host does, then resolve the approval it asked for. */
async function approve(plugin: Plugin, toolCallId: string, name = "partnerstack_create_reward", params: unknown = rewardParams, decision = "allow-once", ctx: Record<string, unknown> = hookCtx) {
  const result = (await plugin.hook({ toolName: name, params, toolCallId }, ctx)) as Approval;
  expect(result).toHaveProperty("requireApproval");
  result.requireApproval.onResolution(decision);
  return result;
}

async function approvedWrite(plugin: Plugin, toolCallId: string, name = "partnerstack_create_reward", params: unknown = rewardParams, ctx = salesCtx, signal?: AbortSignal) {
  await approve(plugin, toolCallId, name, params);
  const tool = plugin.writeTool(name, ctx);
  if (!tool) throw new Error(`${name} was not offered`);
  return tool.execute(toolCallId, params, signal);
}

const posts = (plugin: Plugin, path = "/rewards") => plugin.backend.calls.filter((c) => c.method === "POST" && c.path === path);
const ledgerRows = (dir: string) => readFileSync(join(dir, "partnerstack-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("partnerstack", () => {
  it("registers five read tools, three write factories marked optional, and the policy hook", () => {
    const { tools, factories } = registerPlugin();
    expect([...tools.keys()]).toEqual([...READ_TOOLS]);
    expect([...factories.keys()]).toEqual([...WRITE_TOOLS]);
  });

  it("keeps openclaw.plugin.json in step with the config schema and the tool names", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.id).toBe("partnerstack");
    expect(manifest.configSchema).toEqual(JSON.parse(JSON.stringify(configSchema)));
    expect(manifest.contracts.tools).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    for (const name of WRITE_TOOLS) expect(manifest.toolMetadata[name]).toEqual({ optional: true });
  });

  it("reads pass the hook and return the documented envelope shape", async () => {
    const { tools, hook } = registerPlugin();
    expect(await hook({ toolName: "partnerstack_list_rewards", params: {}, toolCallId: "c-r" }, hookCtx)).toBeUndefined();
    const page = (await tools.get("partnerstack_list_rewards")!.execute("c-r", { limit: 1 })).details as { items: Array<{ key: string; created_at: number }>; has_more: boolean };
    expect(page.items).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.items[0].key).toMatch(/^rew_/);
    expect(Number.isInteger(page.items[0].created_at)).toBe(true);
  });

  it("never offers a money tool to an anonymous run or a wrong agent", () => {
    const plugin = registerPlugin();
    expect(plugin.writeTool("partnerstack_create_reward", { ...salesCtx, requesterSenderId: undefined })).toBeNull();
    expect(plugin.writeTool("partnerstack_create_reward", { ...salesCtx, agentId: "marketing" })).toBeNull();
    expect(plugin.writeTool("partnerstack_create_reward", salesCtx)).not.toBeNull();
  });

  it("the grant's field list is checked against the request's own keys", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-f", "partnerstack_create_reward", { ...rewardParams, notes: "outside" });
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(tool.execute("c-f", { ...rewardParams, notes: "outside" })).rejects.toThrow(/fields outside the grant: notes/);
    expect(posts(plugin)).toHaveLength(0);
  });

  it("blocks an over-cap amount, a manual reward target, a transaction with no customer reference, bad metadata, and a missing agent", async () => {
    const { hook } = registerPlugin({ maxWriteCents: 5000 });
    const overCap = await hook({ toolName: "partnerstack_create_reward", params: { ...rewardParams, amount: 5001 }, toolCallId: "c-1" }, hookCtx);
    expect(overCap).toMatchObject({ block: true });
    expect(String((overCap as { blockReason: string }).blockReason)).toContain("5000");
    const manual = await hook({ toolName: "partnerstack_create_reward", params: { ...rewardParams, target: { type: "manual", key: "psh_2001" } }, toolCallId: "c-2" }, hookCtx);
    expect(manual).toMatchObject({ block: true });
    expect(String((manual as { blockReason: string }).blockReason)).toContain("manual");
    const noCustomer = await hook({ toolName: "partnerstack_create_transaction", params: { amount: 100, currency: "USD" }, toolCallId: "c-3" }, hookCtx);
    expect(noCustomer).toMatchObject({ block: true });
    const badKey = await hook(
      { toolName: "partnerstack_create_transaction", params: { amount: 100, currency: "USD", customer_key: "cust_1001", metadata: { "bad key!": "x" } }, toolCallId: "c-3b" },
      hookCtx,
    );
    expect(String((badKey as { blockReason: string }).blockReason)).toContain("bad key!");
    const longValue = await hook(
      { toolName: "partnerstack_create_transaction", params: { amount: 100, currency: "USD", customer_key: "cust_1001", metadata: { note: "x".repeat(101) } }, toolCallId: "c-3c" },
      hookCtx,
    );
    expect(String((longValue as { blockReason: string }).blockReason)).toContain("100");
    const noAgent = await hook({ toolName: "partnerstack_create_reward", params: rewardParams, toolCallId: "c-4" }, {});
    expect(noAgent).toMatchObject({ block: true });
  });

  it("an in-range write requires human approval, critical, deny on timeout, allow-once or deny only", async () => {
    const { hook } = registerPlugin({ maxWriteCents: 5000, approvalTimeoutMs: 90_000 });
    const decision = await hook({ toolName: "partnerstack_create_reward", params: rewardParams, toolCallId: "c-5" }, hookCtx);
    expect(decision).toMatchObject({
      requireApproval: { severity: "critical", timeoutBehavior: "deny", timeoutMs: 90_000, allowedDecisions: ["allow-once", "deny"], pluginId: "partnerstack" },
    });
    const description = (decision as Approval).requireApproval.description;
    expect(description).toContain("sales");
    expect(description).toContain("2500");
    expect(description).toContain("cust_1001");
  });

  it("the same reward requested twice hits the backend once and returns the first key", async () => {
    const plugin = registerPlugin();
    const first = (await approvedWrite(plugin, "c-6")).details as { key: string; description: string };
    const second = (await approvedWrite(plugin, "c-7")).details as { key: string };
    expect(second.key).toBe(first.key);
    expect(posts(plugin)).toHaveLength(1);
    expect(first.description).toContain("agent=sales");
    expect(first.description).toContain("actor=dana.whitfield@northwind.example");
    expect(first.description).toMatch(/idem=[0-9a-f]{16}/);
  });

  it("a write is refused when the hook never ran, when approval is pending, denied, timed out or cancelled", async () => {
    const plugin = registerPlugin();
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(tool.execute("c-unseen", rewardParams)).rejects.toBeInstanceOf(PolicyError);
    await plugin.hook({ toolName: "partnerstack_create_reward", params: rewardParams, toolCallId: "c-pending" }, hookCtx);
    await expect(tool.execute("c-pending", rewardParams)).rejects.toThrow(/pending/);
    for (const decision of ["deny", "timeout", "cancelled"]) {
      await approve(plugin, `c-${decision}`, "partnerstack_create_reward", rewardParams, decision);
      await expect(tool.execute(`c-${decision}`, rewardParams)).rejects.toThrow(new RegExp(decision));
    }
    expect(posts(plugin)).toHaveLength(0);
  });

  it("an approval belongs to one prompt, so re-running the hook for the same call id with a new amount cannot borrow it", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-b");
    const bigger = { ...rewardParams, amount: 9000 };
    await plugin.hook({ toolName: "partnerstack_create_reward", params: bigger, toolCallId: "c-b" }, hookCtx); // second prompt, never resolved
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(tool.execute("c-b", bigger)).rejects.toThrow(/pending/);
    await expect(tool.execute("c-b", rewardParams)).rejects.toThrow(/changed after approval/);
    expect(posts(plugin)).toHaveLength(0);
  });

  it("one approval funds one intent for one person, so replaying the approved call as someone else is refused", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-m1");
    const dana = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    const marcus = plugin.writeTool("partnerstack_create_reward", { ...salesCtx, requesterSenderId: "U2" })!;
    const first = (await dana.execute("c-m1", rewardParams)).details as { key: string };
    expect(first.key).toMatch(/^rew_/);
    await expect(marcus.execute("c-m1", rewardParams)).rejects.toThrow(/different person or intent/);
    expect(posts(plugin)).toHaveLength(1);
    const again = (await dana.execute("c-m1", rewardParams)).details as { key: string }; // the same person and intent still gets the cached result
    expect(again.key).toBe(first.key);
  });

  it("the session id of the tool run must match the authorized call, whichever side lacks it", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-sid1");
    const noSessionId = plugin.writeTool("partnerstack_create_reward", { ...salesCtx, sessionId: undefined })!;
    await expect(noSessionId.execute("c-sid1", rewardParams)).rejects.toThrow(/session id/);
    await approve(plugin, "c-sid2", "partnerstack_create_reward", rewardParams, "allow-once", { ...hookCtx, sessionId: undefined });
    const withSessionId = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(withSessionId.execute("c-sid2", rewardParams)).rejects.toThrow(/session id/);
    expect(posts(plugin)).toHaveLength(0);
  });

  it("a write is refused when its parameters, tool, agent or session differ from the authorized call", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-8");
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(tool.execute("c-8", { ...rewardParams, amount: 2600 })).rejects.toThrow(/changed after approval/);
    await approve(plugin, "c-8b", "partnerstack_create_transaction", { amount: 100, currency: "USD", customer_key: "cust_1001" });
    await expect(tool.execute("c-8b", rewardParams)).rejects.toThrow(/is for partnerstack_create_transaction/);
    await approve(plugin, "c-8c");
    const otherSession = plugin.writeTool("partnerstack_create_reward", { ...salesCtx, sessionKey: "agent:sales:other" })!;
    await expect(otherSession.execute("c-8c", rewardParams)).rejects.toThrow(/session/);
    await approve(plugin, "c-8d");
    const noSession = plugin.writeTool("partnerstack_create_reward", { ...salesCtx, sessionKey: undefined })!;
    await expect(noSession.execute("c-8d", rewardParams)).rejects.toThrow(/session/);
    expect(posts(plugin)).toHaveLength(0);
  });

  it("a 429 on a write backs off and re-issues only after the GET probe finds nothing", async () => {
    const plugin = registerPlugin();
    plugin.backend.rateLimitNext(1);
    const result = (await approvedWrite(plugin, "c-9")).details as { key: string };
    expect(result.key).toMatch(/^rew_/);
    const order = plugin.backend.calls.map((c) => `${c.method} ${c.path}${c.status === 429 ? " 429" : ""}`);
    expect(order).toEqual(["POST /rewards 429", "GET /rewards", "POST /rewards"]);
    expect(plugin.sleeps).toEqual([500]);
  });

  it("a 429 on a read retries with backoff and returns the page", async () => {
    const plugin = registerPlugin();
    plugin.backend.rateLimitNext(2);
    const page = (await plugin.tools.get("partnerstack_list_partnerships")!.execute("c-10", {})).details as { items: unknown[] };
    expect(page.items).toHaveLength(2);
    expect(plugin.backend.calls.map((c) => c.status)).toEqual([429, 429, 200]);
    expect(plugin.sleeps).toEqual([500, 1000]);
  });

  it("a second identical write while the first is in flight is refused, never sent twice", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-11");
    await approve(plugin, "c-12");
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    plugin.backend.delayNext(1);
    const inFlight = tool.execute("c-11", rewardParams);
    await tick();
    await expect(tool.execute("c-12", rewardParams)).rejects.toBeInstanceOf(DuplicateInFlightError);
    plugin.backend.release();
    await inFlight;
    expect(posts(plugin)).toHaveLength(1);
  });

  it("an unconfirmed earlier send is never re-sent, even long after it, and even when the outcome was unknown", async () => {
    const clock = fakeClock(1_000_000);
    const plugin = registerPlugin({ inflightWindowMs: 1000 }, fakeSeam, { clock });
    await approve(plugin, "c-13");
    await approve(plugin, "c-14");
    await approve(plugin, "c-15");
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    // The first attempt gets a malformed 200, an unknown outcome: the reward may or may not exist.
    plugin.backend.malformedNext(1);
    await expect(tool.execute("c-13", rewardParams)).rejects.toBeInstanceOf(ProtocolError);
    const failed = ledgerRows(plugin.ledgerDir).find((r) => r.kind === "failed" && r.toolCallId === "c-13");
    expect(failed.outcome).toBe("unknown");
    // A later identical call probes once and refuses to send again when the probe finds nothing.
    clock.advance(5000);
    await expect(tool.execute("c-14", rewardParams)).rejects.toBeInstanceOf(UnresolvedWriteError);
    expect(posts(plugin)).toHaveLength(1);
    // A stale sent row with no outcome at all behaves the same way.
    appendFileSync(join(plugin.ledgerDir, "partnerstack-ledger.jsonl"), `${JSON.stringify({ kind: "sent", ts: clock.now() - 60_000, idem: failed.idem, toolCallId: "c-old" })}\n`);
    await expect(tool.execute("c-15", rewardParams)).rejects.toBeInstanceOf(UnresolvedWriteError);
    expect(posts(plugin)).toHaveLength(1);
  });

  it("a 2xx with no record key is an unknown outcome, never a cached success", async () => {
    const plugin = registerPlugin();
    await approve(plugin, "c-e1");
    await approve(plugin, "c-e2");
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    plugin.backend.emptyDataNext(1);
    await expect(tool.execute("c-e1", rewardParams)).rejects.toBeInstanceOf(ProtocolError);
    const rows = ledgerRows(plugin.ledgerDir);
    expect(rows.some((r) => r.kind === "ok")).toBe(false);
    expect(rows.find((r) => r.kind === "failed" && r.toolCallId === "c-e1").outcome).toBe("unknown");
    await expect(tool.execute("c-e2", rewardParams)).rejects.toBeInstanceOf(UnresolvedWriteError);
    expect(posts(plugin)).toHaveLength(1);
  });

  it("after PartnerStack rejects a write, one concurrent pair of identical retries sends exactly once", async () => {
    const plugin = registerPlugin();
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await approve(plugin, "c-16");
    plugin.backend.rejectNext(1);
    await expect(tool.execute("c-16", rewardParams)).rejects.toThrow(/rejected by the test backend/);
    expect(ledgerRows(plugin.ledgerDir).find((r) => r.kind === "failed").outcome).toBe("rejected");
    // Same parameters, same person, two retries racing after the rejection.
    await approve(plugin, "c-17");
    await approve(plugin, "c-18");
    plugin.backend.delayNext(1);
    const a = tool.execute("c-17", rewardParams);
    await tick();
    const b = tool.execute("c-18", rewardParams);
    plugin.backend.release();
    const result = (await a).details as { key: string };
    expect(result.key).toMatch(/^rew_/);
    await expect(b).rejects.toBeInstanceOf(DuplicateInFlightError);
    expect(posts(plugin).map((c) => c.status)).toEqual([400, 200]);
  });

  it("a retry from another session reconciles the reward the first session created", async () => {
    const plugin = registerPlugin();
    const first = (await approvedWrite(plugin, "c-s1")).details as { key: string };
    const idem = ledgerRows(plugin.ledgerDir).find((r) => r.kind === "ok").idem;
    // The record exists but the ledger only remembers an unconfirmed send, as after a lost response.
    appendFileSync(join(plugin.ledgerDir, "partnerstack-ledger.jsonl"), `${JSON.stringify({ kind: "sent", ts: 1, idem, toolCallId: "c-lost" })}\n`);
    const otherHook = { ...hookCtx, sessionKey: "agent:sales:later", sessionId: "s-2" };
    await approve(plugin, "c-s2", "partnerstack_create_reward", rewardParams, "allow-once", otherHook);
    const tool = plugin.writeTool("partnerstack_create_reward", { ...salesCtx, sessionKey: "agent:sales:later", sessionId: "s-2" })!;
    const again = (await tool.execute("c-s2", rewardParams)).details as { key: string };
    expect(again.key).toBe(first.key);
    expect(posts(plugin)).toHaveLength(1);
  });

  it("a probe that finds a different record under our transaction key is a conflict, not a success", async () => {
    const plugin = registerPlugin();
    const params = { key: "tr_4001", amount: 3000, currency: "USD", customer_key: "cust_1002" };
    await approve(plugin, "c-19", "partnerstack_create_transaction", params);
    const tool = plugin.writeTool("partnerstack_create_transaction", salesCtx)!;
    plugin.backend.rateLimitNext(1);
    await expect(tool.execute("c-19", params)).rejects.toBeInstanceOf(ConflictError);
    expect(posts(plugin, "/transactions").filter((c) => c.status === 200)).toHaveLength(0);
    expect(plugin.backend.transactions.get("tr_4001")!.amount).toBe(120000);
  });

  it("a transaction carries the actor in metadata and a derived idempotency key, and the second send is deduplicated", async () => {
    const plugin = registerPlugin();
    const params = { amount: 9900, currency: "USD", customer_key: "cust_1002", metadata: { invoice: "INV-77" } };
    const tx = (await approvedWrite(plugin, "c-20", "partnerstack_create_transaction", params)).details as { key: string; metadata: Record<string, string> };
    expect(tx.key).toMatch(/^ps_[0-9a-f]{32}$/);
    expect(tx.metadata).toMatchObject({ invoice: "INV-77", ps_agent: "sales", ps_actor: "dana.whitfield@northwind.example", ps_session: "agent:sales:main" });
    const again = (await approvedWrite(plugin, "c-21", "partnerstack_create_transaction", params)).details as { key: string };
    expect(again.key).toBe(tx.key);
    expect(posts(plugin, "/transactions")).toHaveLength(1);
  });

  it("an aborted signal stops a write before it is sent and leaves it safe to retry", async () => {
    const plugin = registerPlugin();
    const controller = new AbortController();
    controller.abort();
    await expect(approvedWrite(plugin, "c-22", "partnerstack_create_reward", rewardParams, salesCtx, controller.signal)).rejects.toThrow(/aborted/);
    expect(posts(plugin)).toHaveLength(0);
    const result = (await approvedWrite(plugin, "c-23")).details as { key: string };
    expect(result.key).toMatch(/^rew_/);
  });

  it("a call cancelled while waiting for the pace gives its slot back", async () => {
    const clock = fakeClock(0);
    const plugin = registerPlugin({ maxConcurrent: 1, maxRequestsPerMinute: 1 }, fakeSeam, { clock, sleep: () => new Promise<void>(() => {}) });
    const list = plugin.tools.get("partnerstack_list_partnerships")!;
    await list.execute("c-p1", {});
    const controller = new AbortController();
    const waiting = list.execute("c-p2", {}, controller.signal); // holds the only slot while it waits out the minute
    await tick();
    const queued = list.execute("c-p3", {});
    await tick();
    clock.set(60_001);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    const page = (await queued).details as { items: unknown[] };
    expect(page.items).toHaveLength(2);
    expect(plugin.backend.calls).toHaveLength(2);
  });

  it("the idempotency key is scoped to the backend, and a trailing slash on the base URL is the same destination", async () => {
    const plugin = registerPlugin();
    await approvedWrite(plugin, "c-24");
    const http = registerPlugin({ ledgerDir: plugin.ledgerDir, backend: "http", baseUrl: "https://api.partnerstack.com/api/v2/", publicKey: "pk_test", secretKey: "sk_test" });
    await approvedWrite(http, "c-25");
    expect(posts(http)).toHaveLength(1);
    const same = registerPlugin({ ledgerDir: plugin.ledgerDir, backend: "http", baseUrl: "https://api.partnerstack.com/api/v2", publicKey: "pk_test", secretKey: "sk_test" });
    await approvedWrite(same, "c-26");
    expect(posts(same)).toHaveLength(0);
  });

  it("a corrupt ledger tail stops money writes with a typed error, reads keep working", async () => {
    const plugin = registerPlugin();
    await approvedWrite(plugin, "c-27");
    appendFileSync(join(plugin.ledgerDir, "partnerstack-ledger.jsonl"), '{"kind":"sent","ts":1,"idem":"trunc');
    await approve(plugin, "c-28");
    const tool = plugin.writeTool("partnerstack_create_reward", salesCtx)!;
    await expect(tool.execute("c-28", rewardParams)).rejects.toBeInstanceOf(LedgerCorruptError);
    const page = (await plugin.tools.get("partnerstack_list_customers")!.execute("c-29", {})).details as { items: unknown[] };
    expect(page.items).toHaveLength(2);
  });

  it("an exhausted daily budget throws a typed error before any call, and a malformed counter fails closed", async () => {
    const plugin = registerPlugin({ dailyCallBudget: 2 });
    const list = plugin.tools.get("partnerstack_list_partnerships")!;
    await list.execute("c-30", {});
    await list.execute("c-31", {});
    await expect(list.execute("c-32", {})).rejects.toBeInstanceOf(BudgetExceededError);
    expect(plugin.backend.calls).toHaveLength(2);
    const budgetPath = join(plugin.ledgerDir, "partnerstack-budget.json");
    expect(JSON.parse(readFileSync(budgetPath, "utf8")).count).toBe(2);
    writeFileSync(budgetPath, '{"day":"2026-09-15"}');
    await expect(list.execute("c-33", {})).rejects.toBeInstanceOf(BudgetStateError);
    writeFileSync(budgetPath, '{"day":"not-a-date","count":5000}');
    await expect(list.execute("c-34", {})).rejects.toBeInstanceOf(BudgetStateError);
    writeFileSync(budgetPath, '{"day":"2026-13-15","count":5000}');
    await expect(list.execute("c-34b", {})).rejects.toBeInstanceOf(BudgetStateError);
    expect(plugin.backend.calls).toHaveLength(2);
  });

  it("a budget lock left by a dead process is reclaimed, so the counter keeps working", async () => {
    const plugin = registerPlugin({ dailyCallBudget: 5 });
    const lockDir = join(plugin.ledgerDir, "partnerstack-budget.json.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), "999999");
    const page = (await plugin.tools.get("partnerstack_list_partnerships")!.execute("c-35", {})).details as { items: unknown[] };
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(plugin.ledgerDir, "partnerstack-budget.json"), "utf8")).count).toBe(1);
  });

  it("paces on a rolling minute, not a calendar minute", async () => {
    const clock = fakeClock(0);
    const plugin = registerPlugin({ maxRequestsPerMinute: 2 }, fakeSeam, { clock });
    const list = plugin.tools.get("partnerstack_list_partnerships")!;
    await list.execute("c-36", {});
    clock.set(59_999);
    await list.execute("c-37", {});
    // A calendar-minute limiter would admit a third call here at 59999 and a fourth at 60000. The rolling window waits until the t=0 call ages out.
    await list.execute("c-38", {});
    expect(plugin.sleeps).toEqual([2]);
    expect(clock.now()).toBe(60_001);
    expect(plugin.backend.calls).toHaveLength(3);
  });

  it("caps in-flight calls at maxConcurrent", async () => {
    const plugin = registerPlugin({ maxConcurrent: 2 });
    plugin.backend.delayNext(2);
    const list = plugin.tools.get("partnerstack_list_customers")!;
    const calls = [list.execute("c-39", {}), list.execute("c-40", {}), list.execute("c-41", {})];
    await tick();
    expect(plugin.backend.inFlight).toBe(2);
    plugin.backend.release();
    await Promise.all(calls);
    expect(plugin.backend.maxObservedInFlight).toBe(2);
    expect(plugin.backend.calls).toHaveLength(3);
  });

  it("every write leaves authorize, decision, sent and ok rows in the ledger with agent, person, namespace and idempotency key", async () => {
    const plugin = registerPlugin();
    await approvedWrite(plugin, "c-42");
    const rows = ledgerRows(plugin.ledgerDir);
    expect(rows.filter((r) => r.toolCallId === "c-42").map((r) => r.kind)).toEqual(["authorize", "decision", "sent", "ok"]);
    const auth = rows.find((r) => r.kind === "authorize" && r.toolCallId === "c-42");
    expect(auth.authId).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.find((r) => r.kind === "decision" && r.toolCallId === "c-42").authId).toBe(auth.authId);
    const sent = rows.find((r) => r.kind === "sent" && r.toolCallId === "c-42");
    expect(sent).toMatchObject({ agentId: "sales", sessionKey: "agent:sales:main", tool: "partnerstack_create_reward", actor: "dana.whitfield@northwind.example", role: "csm", surface: "webchat", namespace: "mock" });
    expect(sent.idem).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.find((r) => r.kind === "ok" && r.toolCallId === "c-42").key).toMatch(/^rew_/);
  });
});
