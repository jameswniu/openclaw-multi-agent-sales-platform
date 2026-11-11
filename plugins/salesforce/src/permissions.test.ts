// Vitest suite for the Salesforce plugin's write guard. It calls the real plugin entry the way the
// gateway does, with the real config/permissions.json and config/users.json. It checks which callers
// are offered each write tool, which fields they may change and the bulk record cap.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import entry from "./index.js";

// Drives the real plugin entry through the SDK contract the gateway uses:
// entry.register(api) hands each tool to api.registerTool either as a static
// tool object or as a factory that receives the runtime tool context.
type ToolLike = { name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> };
type Registration = ToolLike | ((toolContext: Record<string, unknown>) => ToolLike | null | undefined);

const pluginConfig = {
  permissionsPath: fileURLToPath(new URL("../../../config/permissions.json", import.meta.url)),
  usersPath: fileURLToPath(new URL("../../../config/users.json", import.meta.url)),
};

function registerAll(): Map<string, Registration> {
  const registered = new Map<string, Registration>();
  const api = {
    pluginConfig,
    registerTool(tool: Registration, opts?: { name?: string }) {
      const name = opts?.name ?? (typeof tool === "function" ? undefined : tool.name);
      if (!name) {
        throw new Error("registerTool called without a resolvable name");
      }
      registered.set(name, tool);
    },
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  return registered;
}

function offered(registration: Registration | undefined, toolContext: Record<string, unknown>): ToolLike | null {
  if (!registration) {
    throw new Error("tool was never registered");
  }
  return typeof registration === "function" ? (registration(toolContext) ?? null) : registration;
}

const marcusOnSlack = { agentId: "sales", sessionKey: "agent:sales:main", messageChannel: "slack", requesterSenderId: "U0MARCUS" };
const jordanOnSlack = { agentId: "sales", sessionKey: "agent:sales:main", messageChannel: "slack", requesterSenderId: "U0JORDAN" };

describe("salesforce write permissions", () => {
  it("does not offer salesforce_update_account to an anonymous webchat run", () => {
    const tools = registerAll();
    const update = offered(tools.get("salesforce_update_account"), { agentId: "sales", sessionKey: "agent:sales:main", messageChannel: "webchat" });
    expect(update).toBeNull();
  });

  it("keeps the read tools available without a principal", () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_list_accounts"), {})).not.toBeNull();
    expect(offered(tools.get("salesforce_get_account"), {})).not.toBeNull();
  });

  it("denies a sender that is not in the identity map", () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_update_account"), { ...marcusOnSlack, requesterSenderId: "U0NOBODY" })).toBeNull();
  });

  it("denies a granted user on a surface outside the grant", () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_update_account"), { ...marcusOnSlack, messageChannel: "telegram" })).toBeNull();
  });

  it("denies a granted user when the agent runs as a subagent", () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_update_account"), { ...marcusOnSlack, sessionKey: "agent:sales:subagent:0f3c" })).toBeNull();
  });

  it("denies a granted user on an agent without a grant", () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_update_account"), { ...marcusOnSlack, agentId: "auditor" })).toBeNull();
  });

  it("offers the update to a granted user and rejects a field outside the grant", async () => {
    const tools = registerAll();
    const update = offered(tools.get("salesforce_update_account"), marcusOnSlack);
    expect(update).not.toBeNull();
    await expect(update!.execute("call_1", { accountId: "acc_1001", fields: { arr: 1 } })).rejects.toThrow(/arr/);
    const result = (await update!.execute("call_2", { accountId: "acc_1001", fields: { stage: "negotiation" } })) as { details: { stage: string } };
    expect(result.details.stage).toBe("negotiation");
  });

  it("denies bulk updates to everyone but revops-admin and caps what revops-admin can touch", async () => {
    const tools = registerAll();
    expect(offered(tools.get("salesforce_bulk_update_accounts"), marcusOnSlack)).toBeNull();
    const bulk = offered(tools.get("salesforce_bulk_update_accounts"), jordanOnSlack);
    expect(bulk).not.toBeNull();
    await expect(bulk!.execute("call_3", { accountIds: ["acc_1001"], fields: { stage: "closed_won" } })).rejects.toThrow(/stage/);
    const tooMany = Array.from({ length: 26 }, (_, i) => `acc_${1001 + (i % 5)}`);
    await expect(bulk!.execute("call_4", { accountIds: tooMany, fields: { owner: "sales-team" } })).rejects.toThrow(/25/);
    const result = (await bulk!.execute("call_5", { accountIds: ["acc_1001", "acc_1002"], fields: { owner: "sales-team" } })) as { details: Array<{ owner: string }> };
    expect(result.details.map((account) => account.owner)).toEqual(["sales-team", "sales-team"]);
  });
});
