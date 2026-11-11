// Vitest suite for the user-memory plugin in index.ts: the memory tools, the prompt hook and the plugin
// entry. It uses a temporary folder and the real roster, so it needs no gateway, key or network.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "openclaw-policy-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry, { bootstrapGuard, buildTools, dropSharedMemory, promptHook, type UserMemoryOptions } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const policy = loadPolicy({
  permissionsPath: path.join(repoRoot, "config", "permissions.json"),
  usersPath: path.join(repoRoot, "config", "users.json"),
});

// Two canonical non-operator gateway client ids, mapped to two roster users in config/permissions.json.
const DANA = { agentId: "sales", messageChannel: "webchat", requesterSenderId: "webchat", sessionKey: "agent:sales:main" };
const MARCUS = { agentId: "sales", messageChannel: "webchat", requesterSenderId: "gateway-client", sessionKey: "agent:sales:main" };
const NOBODY = { agentId: "sales", messageChannel: "webchat", sessionKey: "agent:sales:main" };

let opts: UserMemoryOptions;

function toolsFor(ctx: object) {
  const [remember, recall] = buildTools(ctx as never, opts);
  return {
    remember: (note: string) => remember.execute("call", { note }),
    recall: async () => (await recall.execute()).content[0].text,
  };
}

beforeEach(async () => {
  opts = { policy, rootDir: await fs.mkdtemp(path.join(os.tmpdir(), "user-memory-plugin-")), maxBytes: 16 * 1024 };
});

afterEach(async () => {
  await fs.rm(opts.rootDir, { recursive: true, force: true });
});

describe("user-memory tools", () => {
  it("dana remembers, marcus recalls nothing, dana recalls, then the same the other way", async () => {
    const dana = toolsFor(DANA);
    const marcus = toolsFor(MARCUS);

    await dana.remember("my territory is the west coast");
    expect(await marcus.recall()).toBe("Nothing remembered for this user yet.");
    expect(await dana.recall()).toContain("my territory is the west coast");

    await marcus.remember("my territory is the east coast");
    expect(await dana.recall()).not.toContain("east coast");
    expect(await marcus.recall()).toContain("east coast");
    expect(await marcus.recall()).not.toContain("west coast");
  });

  it("refuses when the principal has no user", async () => {
    const nobody = toolsFor(NOBODY);
    await expect(nobody.remember("anything")).rejects.toThrow(/no user identity/);
    await expect(nobody.recall()).rejects.toThrow(/no user identity/);
    const files = await fs.readdir(opts.rootDir);
    expect(files).toEqual([]);
  });

  it("keeps the file at or under the cap after writing past it", async () => {
    const dana = toolsFor(DANA);
    for (let i = 0; i < 40; i += 1) {
      await dana.remember(`${i} ${"x".repeat(900)}`);
    }
    const [agentDir] = await fs.readdir(opts.rootDir);
    const [file] = await fs.readdir(path.join(opts.rootDir, agentDir));
    const stat = await fs.stat(path.join(opts.rootDir, agentDir, file));
    expect(stat.size).toBeLessThanOrEqual(16 * 1024);
    expect(await dana.recall()).toContain(": 39 ");
    expect(await dana.recall()).not.toContain(": 0 ");
  });
});

describe("prompt hook", () => {
  it("injects only the asking user's notes", async () => {
    await toolsFor(DANA).remember("prefers a call before email");
    const danaCtx = { agentId: "sales", messageProvider: "webchat", senderId: "webchat", sessionKey: "agent:sales:main" };
    const marcusCtx = { agentId: "sales", messageProvider: "webchat", senderId: "gateway-client", sessionKey: "agent:sales:main" };
    const nobodyCtx = { agentId: "sales", messageProvider: "webchat", sessionKey: "agent:sales:main" };

    const forDana = await promptHook(danaCtx as never, opts);
    expect(forDana?.prependSystemContext).toContain("prefers a call before email");
    expect(forDana?.prependSystemContext).toContain("dana.whitfield@northwind.example");
    expect(await promptHook(marcusCtx as never, opts)).toBeUndefined();
    expect(await promptHook(nobodyCtx as never, opts)).toBeUndefined();
  });
});

describe("plugin entry", () => {
  it("registers the two tools, the bootstrap guard and the prompt hook through the plugin api", () => {
    process.env.OPENCLAW_CONFIG_PATH = path.join(repoRoot, "openclaw.json");
    const calls: string[] = [];
    let factory: ((ctx: object) => unknown) | undefined;
    const api = {
      pluginConfig: undefined,
      registerTool: (tool: unknown) => {
        calls.push("registerTool");
        factory = tool as (ctx: object) => unknown;
      },
      registerHook: (events: string | string[], _handler: unknown, opts?: { name?: string }) => {
        calls.push(`registerHook:${String(events)}:${opts?.name ?? "MISSING_NAME"}`);
      },
      on: (name: string) => {
        calls.push(`on:${name}`);
      },
    };
    entry.register?.(api as never);
    expect(calls).toEqual(["registerTool", "registerHook:agent:bootstrap:user-memory-bootstrap-guard", "on:before_prompt_build"]);
    const tools = factory!(DANA) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["memory_remember", "memory_recall"]);
  });

  it("drops the shared MEMORY.md from the bootstrap set and keeps everything else", () => {
    expect(dropSharedMemory([{ name: "AGENTS.md" }, { name: "MEMORY.md" }, { name: "USER.md" }]).map((f) => f.name)).toEqual(["AGENTS.md", "USER.md"]);
    const event = { type: "agent", action: "bootstrap", context: { bootstrapFiles: [{ name: "SOUL.md" }, { name: "MEMORY.md" }] } };
    bootstrapGuard(event);
    expect(event.context.bootstrapFiles.map((f) => f.name)).toEqual(["SOUL.md"]);
    const other = { type: "command", action: "new", context: { bootstrapFiles: [{ name: "MEMORY.md" }] } };
    bootstrapGuard(other);
    expect(other.context.bootstrapFiles).toHaveLength(1);
  });

  it("still reaches the loader when the registry hands the hook a shallow copy of the context", () => {
    const original = { type: "agent", action: "bootstrap", context: { bootstrapFiles: [{ name: "AGENTS.md" }, { name: "MEMORY.md" }] } };
    const copyAsTheRegistryDoes = { ...original, context: { ...original.context, pluginConfig: undefined } };
    bootstrapGuard(copyAsTheRegistryDoes);
    expect(original.context.bootstrapFiles.map((f) => f.name)).toEqual(["AGENTS.md"]);
  });
});
