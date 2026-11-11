// User-memory plugin for the OpenClaw gateway. It gives each agent a memory file per person, so two
// people using the same agent never see each other's notes. The caller is resolved by the shared
// permission guard in plugins/policy-core. The plugin also removes the agent's shared memory file from
// the prompt and adds the caller's own notes. File reading and writing live in store.ts.

import path from "node:path";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { defaultPolicyPaths, fromAgentHookContext, fromToolContext, loadPolicy, resolvePrincipal } from "openclaw-policy-core";
import type { AgentHookContextLike, Policy } from "openclaw-policy-core";
import { DEFAULT_MAX_BYTES, appendMemory, memoryFilePath, readMemory } from "./store.js";

export type UserMemoryOptions = {
  policy: Policy;
  rootDir: string;
  maxBytes: number;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function text(value: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: value }], details };
}

/** The permission model decides who is asking. No user means no memory, never a session-key fallback. */
function requireUser(principal: { user: string | null }): string {
  if (!principal.user) {
    throw new Error("user memory unavailable: this session carries no user identity");
  }
  return principal.user;
}

function requireAgent(agentId: string | undefined): string {
  if (!agentId) {
    throw new Error("user memory unavailable: no agent id on this run");
  }
  return agentId;
}

export function resolveMemoryRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "user-memory");
}

const SHARED_MEMORY_FILENAME = "MEMORY.md";

/**
 * The gateway injects a workspace MEMORY.md for every session whatever the memory slot says, so it is
 * removed here. The array is edited in place on purpose: the plugin registry hands hooks a shallow copy
 * of the event context, so replacing the array would never reach the bootstrap loader.
 */
export function dropSharedMemory<T extends { name?: string }>(files: T[]): T[] {
  for (let i = files.length - 1; i >= 0; i -= 1) {
    if (files[i]?.name === SHARED_MEMORY_FILENAME) {
      files.splice(i, 1);
    }
  }
  return files;
}

type BootstrapHookEvent = { type?: string; action?: string; context?: { bootstrapFiles?: unknown } };

export function bootstrapGuard(event: BootstrapHookEvent): void {
  if (event.type !== "agent" || event.action !== "bootstrap" || !event.context) {
    return;
  }
  const files = event.context.bootstrapFiles;
  if (Array.isArray(files)) {
    dropSharedMemory(files as Array<{ name?: string }>);
  }
}

/** Builds the two tools for one run. The principal is resolved once, from runtime context only. */
export function buildTools(toolContext: OpenClawPluginToolContext, opts: UserMemoryOptions) {
  const principal = resolvePrincipal(fromToolContext(toolContext), opts.policy);
  const agentId = toolContext.agentId;
  const fileFor = () => memoryFilePath(opts.rootDir, requireAgent(agentId), requireUser(principal));

  const remember = {
    name: "memory_remember",
    label: "Remember",
    description:
      "Save one durable fact about the current user for future sessions, such as their accounts, territory, or preferences. Private to this user and this agent.",
    parameters: Type.Object({
      note: Type.String({ description: "One fact to keep, in plain words." }),
    }),
    execute: async (_toolCallId: string, params: { note: string }) => {
      const result = await appendMemory(fileFor(), params.note, { maxBytes: opts.maxBytes });
      return text(
        `Remembered. ${result.entries} notes kept for this user${result.dropped > 0 ? `, ${result.dropped} oldest dropped to stay under the cap` : ""}.`,
        result,
      );
    },
  };

  const recall = {
    name: "memory_recall",
    label: "Recall",
    description: "Read everything remembered about the current user for this agent. Returns only this user's notes.",
    parameters: Type.Object({}),
    execute: async () => {
      const notes = await readMemory(fileFor());
      return text(notes.trim() ? notes : "Nothing remembered for this user yet.", { bytes: Buffer.byteLength(notes) });
    },
  };

  return [remember, recall] as [typeof remember, typeof recall];
}

/** Injects only the asking user's notes into the system prompt, so they never start cold. */
export async function promptHook(ctx: AgentHookContextLike, opts: UserMemoryOptions) {
  const principal = resolvePrincipal(fromAgentHookContext(ctx), opts.policy);
  if (!principal.user || !ctx.agentId) {
    return;
  }
  const notes = await readMemory(memoryFilePath(opts.rootDir, ctx.agentId, principal.user));
  if (!notes.trim()) {
    return;
  }
  return {
    prependSystemContext: `## What you remember about ${principal.user} (private to them)\n${notes.trim()}\n`,
  };
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "user-memory",
  name: "User Memory",
  description: "Per-user memory, keyed by the permission model's principal, one capped file per agent and user.",
  register(api) {
    const opts: UserMemoryOptions = {
      policy: loadPolicy(defaultPolicyPaths()),
      rootDir: resolveMemoryRootDir(),
      maxBytes: readMaxBytes(api.pluginConfig),
    };
    api.registerTool((toolContext) => buildTools(toolContext, opts));
    api.registerHook("agent:bootstrap", (event) => bootstrapGuard(event as BootstrapHookEvent), {
      name: "user-memory-bootstrap-guard",
      description: "Drops the shared workspace MEMORY.md from every session's bootstrap files.",
    });
    api.on("before_prompt_build", (_event, ctx) => promptHook(ctx, opts));
  },
});

export default entry;

function readMaxBytes(pluginConfig: unknown): number {
  const raw = (pluginConfig as { maxBytes?: unknown } | undefined)?.maxBytes;
  if (raw === undefined) {
    return DEFAULT_MAX_BYTES;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1024) {
    throw new Error("user memory: maxBytes must be an integer of at least 1024");
  }
  return raw;
}
