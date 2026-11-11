// Type declarations for index.js in this folder, the shared permission guard used by every plugin.
// A grant is one entry in config/permissions.json. A principal is the caller resolved from the gateway
// context: user, role, agent and surface (the channel the request came from).

export const DEFAULT_PERMISSIONS_PATH: string;
export const DEFAULT_USERS_PATH: string;
export const SUBAGENT_SURFACE: "subagent";
export const CLI_SURFACE: "cli";

export type Grant = {
  /** Invocation surfaces the write is allowed from, e.g. "webchat", "slack". "subagent" and "cli" are never granted by default. */
  surfaces: string[];
  /** Field names the write may touch. */
  fields?: string[];
  /** Upper bound on records per call for bulk tools. */
  maxRecords?: number;
};

export type Policy = {
  readonly identities: Readonly<Record<string, string>>;
  readonly grants: Readonly<Record<string, Record<string, Record<string, Grant>>>>;
  readonly rolesByEmail: Readonly<Record<string, string>>;
  readonly permissionsPath: string;
  readonly usersPath: string;
};

export type PrincipalInput = {
  senderId?: string;
  channel?: string;
  agentId?: string;
  sessionKey?: string;
};

export type Principal = {
  /** users.json email, or null when the runtime supplied no sender or the sender is not in the identity map. */
  readonly user: string | null;
  /** users.json role for `user`, or null. */
  readonly role: string | null;
  readonly agent: string | null;
  /** "subagent" when the session key contains ":subagent:", else the channel, else "cli". */
  readonly surface: string;
  /** "<channel>:<senderId>" as looked up in identities, or null when either half is missing. */
  readonly identityKey: string | null;
  readonly sessionKey: string | null;
};

export type WriteShape = { fields?: unknown; recordCount?: number };

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

export type GuardedToolDefinition<TParams, TSchema = unknown> = {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  /** Extract the parts of `params` the grant constrains. Defaults to `{ fields: params.fields }`. */
  shape?: (params: TParams) => WriteShape;
  /** Runs only after the shape check passes. Return a JSON value or a string. */
  run: (
    params: TParams,
    meta: { principal: Principal; grant: Grant; toolCallId: string; signal?: AbortSignal; onUpdate?: unknown },
  ) => unknown | Promise<unknown>;
};

export type GuardedTool<TSchema = unknown> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<ToolResult>;
};

export type ToolContextLike = {
  requesterSenderId?: string;
  messageChannel?: string;
  agentId?: string;
  sessionKey?: string;
};

export type AgentHookContextLike = {
  senderId?: string;
  messageProvider?: string;
  channel?: string;
  agentId?: string;
  sessionKey?: string;
};

export function defaultPolicyBaseDir(env?: NodeJS.ProcessEnv): string;
export function defaultPolicyPaths(env?: NodeJS.ProcessEnv): { permissionsPath: string; usersPath: string };
export function loadPolicy(options?: { permissionsPath?: string; usersPath?: string }): Policy;
export function fromToolContext(toolContext: ToolContextLike | undefined): PrincipalInput;
export function fromAgentHookContext(ctx: AgentHookContextLike | undefined): PrincipalInput;
export function resolvePrincipal(input: PrincipalInput | undefined, policy: Policy): Principal;
export function grantFor(principal: Principal, policy: Policy, toolName: string): Grant | null;
export function deniedFields(grant: Grant, fields: unknown): string[];
export function checkWriteShape(grant: Grant, shape: WriteShape | undefined): string | null;
export function guardWrite<TParams, TSchema = unknown>(args: {
  toolContext: ToolContextLike | undefined;
  policy: Policy;
  tool: GuardedToolDefinition<TParams, TSchema>;
}): GuardedTool<TSchema> | null;
