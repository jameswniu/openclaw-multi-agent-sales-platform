// Vitest suite that runs the PartnerStack plugin against the real permission guard in plugins/policy-core
// and a temporary copy of the grants file. It shows that a person with a grant is offered the money
// write and a person without one is not. No key and no network.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlugin, WRITE_TOOLS } from "./index.js";
import { createMockBackend } from "./backend.js";

// The real permission model end to end: openclaw-policy-core's loadPolicy reads
// two files on disk, resolvePrincipal maps the run's sender to a person and a
// role, grantFor looks the grant up, and guardWrite builds or withholds the tool
// and checks every call's fields against the grant. The only stand-in is the
// PartnerStack transport, which is the in-memory mock.
//
// The files are copies of the repo's own config/users.json (verbatim) and
// config/permissions.json, with one stanza added for the account-executive role
// on the sales agent. That stanza is the one config/permissions.json still
// needs before the gateway offers a PartnerStack write to anyone.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const MARCUS = "marcus.oyelaran@northwind.example";

const PARTNERSTACK_GRANTS = {
  partnerstack_create_reward: { surfaces: ["webchat"], fields: ["amount", "currency", "description", "target"] },
  // metadata is deliberately not granted, so a request carrying it is refused by guardWrite.
  partnerstack_create_transaction: { surfaces: ["webchat"], fields: ["key", "amount", "currency", "customer_key", "customer_external_key", "customer_email", "product_key", "category_key"] },
  partnerstack_delete_transaction: { surfaces: ["webchat"], fields: ["transaction_key"] },
};

function writePolicyFiles() {
  const dir = mkdtempSync(join(tmpdir(), "ps-policy-"));
  const permissions = JSON.parse(readFileSync(join(REPO, "config", "permissions.json"), "utf8"));
  Object.assign(permissions.grants["account-executive"].sales, PARTNERSTACK_GRANTS);
  writeFileSync(join(dir, "permissions.json"), JSON.stringify(permissions, null, 2));
  writeFileSync(join(dir, "users.json"), readFileSync(join(REPO, "config", "users.json")));
  return { permissionsPath: join(dir, "permissions.json"), usersPath: join(dir, "users.json") };
}

type Tool = { name: string; execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }> };
type Factory = (toolContext: Record<string, unknown>) => Tool | null;
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
type Approval = { requireApproval: { onResolution: (decision: string) => void } };

/** The plugin exactly as the gateway builds it: no seam injected, the real package resolves the person. */
function registerRealPlugin() {
  const backend = createMockBackend();
  const ledgerDir = mkdtempSync(join(tmpdir(), "ps-ledger-"));
  const plugin = createPlugin({ transport: backend.transport });
  const reads = new Map<string, Tool>();
  const factories = new Map<string, Factory>();
  let hook: Hook | undefined;
  if (!plugin.register) throw new Error("plugin has no register");
  plugin.register({
    id: "partnerstack",
    name: "PartnerStack",
    pluginConfig: { backend: "mock", ledgerDir, ...writePolicyFiles() },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (tool: Tool | Factory, opts?: { name?: string }) => {
      if (typeof tool === "function") factories.set(opts?.name ?? "", tool);
      else reads.set(tool.name, tool);
    },
    on: (name: string, handler: Hook) => {
      if (name === "before_tool_call") hook = handler;
    },
  } as never);
  if (!hook) throw new Error("before_tool_call hook was not registered");
  const offered = (name: string, toolContext: Record<string, unknown>) => factories.get(name)!(toolContext);
  const approve = async (name: string, params: unknown, toolCallId: string) => {
    const result = (await hook!({ toolName: name, params, toolCallId }, { agentId: "sales", sessionKey: "agent:sales:main", sessionId: "s-1" })) as Approval;
    expect(result).toHaveProperty("requireApproval");
    result.requireApproval.onResolution("allow-once");
  };
  const ledger = () => readFileSync(join(ledgerDir, "partnerstack-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { backend, reads, factories, offered, approve, ledger };
}

// Identities straight from config/permissions.json: gateway-client is Marcus, an account-executive.
const marcusOnWebchat = { agentId: "sales", sessionKey: "agent:sales:main", sessionId: "s-1", messageChannel: "webchat", requesterSenderId: "gateway-client" };
const danaOnWebchat = { ...marcusOnWebchat, requesterSenderId: "webchat" };
const marcusOnSlack = { ...marcusOnWebchat, messageChannel: "slack", requesterSenderId: "U0MARCUS" };
const nobody = { agentId: "sales", sessionKey: "agent:sales:main", sessionId: "s-1" };

describe("real openclaw-policy-core", () => {
  it("offers all three writes to a granted person and each executes under approval", async () => {
    const plugin = registerRealPlugin();
    for (const name of WRITE_TOOLS) expect(plugin.offered(name, marcusOnWebchat)).not.toBeNull();

    const rewardParams = { amount: 2500, currency: "USD", description: "Q3 referral bonus", target: { type: "customer", key: "cust_1001" } };
    await plugin.approve("partnerstack_create_reward", rewardParams, "c-1");
    const reward = (await plugin.offered("partnerstack_create_reward", marcusOnWebchat)!.execute("c-1", rewardParams)).details as { key: string; description: string };
    expect(reward.key).toMatch(/^rew_/);
    expect(reward.description).toContain(`actor=${MARCUS}`);

    const txParams = { amount: 1200, currency: "USD", customer_key: "cust_1001" };
    await plugin.approve("partnerstack_create_transaction", txParams, "c-2");
    const tx = (await plugin.offered("partnerstack_create_transaction", marcusOnWebchat)!.execute("c-2", txParams)).details as { key: string };
    expect(tx.key).toMatch(/^ps_/);

    const deleteParams = { transaction_key: tx.key };
    await plugin.approve("partnerstack_delete_transaction", deleteParams, "c-3");
    const gone = (await plugin.offered("partnerstack_delete_transaction", marcusOnWebchat)!.execute("c-3", deleteParams)).details as { key: string; archived: boolean };
    expect(gone).toEqual({ key: tx.key, archived: true });

    expect(plugin.backend.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /rewards", "POST /transactions", `DELETE /transactions/${tx.key}`]);
    const okRows = plugin.ledger().filter((row) => row.kind === "ok");
    expect(okRows.map((row) => [row.tool, row.actor, row.role])).toEqual([...WRITE_TOOLS].map((tool) => [tool, MARCUS, "account-executive"]));
  });

  it("never offers a write to a person with no grant, on an ungranted surface, or with no sender, while reads stay", () => {
    const plugin = registerRealPlugin();
    for (const name of WRITE_TOOLS) {
      expect(plugin.offered(name, danaOnWebchat)).toBeNull(); // Dana is a csm, no PartnerStack grant
      expect(plugin.offered(name, marcusOnSlack)).toBeNull(); // Marcus is granted on webchat only
      expect(plugin.offered(name, nobody)).toBeNull(); // no sender resolves no person
    }
    expect(plugin.reads.size).toBe(5);
  });

  it("refuses a field outside the grant inside guardWrite, before the plugin's write path runs", async () => {
    const plugin = registerRealPlugin();
    const params = { amount: 1200, currency: "USD", customer_key: "cust_1001", metadata: { campaign: "spring" } };
    await plugin.approve("partnerstack_create_transaction", params, "c-4"); // the plugin's own shape hook lets metadata through
    const tool = plugin.offered("partnerstack_create_transaction", marcusOnWebchat)!;
    await expect(tool.execute("c-4", params)).rejects.toThrow(`partnerstack_create_transaction denied for ${MARCUS}: fields outside the grant: metadata`);
    expect(plugin.backend.calls).toHaveLength(0);
    expect(plugin.ledger().map((row) => row.kind)).toEqual(["authorize", "decision"]); // no sent row: runWrite never started
  });
});
