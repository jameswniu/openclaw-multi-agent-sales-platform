// openclaw-policy-core
//
// Resolves who is calling a tool (user, role, agent, surface) from the context
// the gateway already supplies, looks the caller up in config/permissions.json
// plus config/users.json, and wraps write tools so they are only offered, and
// only execute, inside a grant. Plain ESM with no dependencies so every plugin
// package can take a copy through `file:../policy-core` and `install-links`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_PERMISSIONS_PATH = "config/permissions.json";
export const DEFAULT_USERS_PATH = "config/users.json";
export const SUBAGENT_SURFACE = "subagent";
export const CLI_SURFACE = "cli";
const SUBAGENT_MARKER = ":subagent:";

/** Directory that relative policy paths resolve against: the folder holding OPENCLAW_CONFIG_PATH, else the process cwd. */
export function defaultPolicyBaseDir(env = process.env) {
  const configPath = nonEmpty(env.OPENCLAW_CONFIG_PATH);
  return configPath ? dirname(resolve(configPath)) : process.cwd();
}

/** Absolute default locations of the two policy files. */
export function defaultPolicyPaths(env = process.env) {
  const base = defaultPolicyBaseDir(env);
  return {
    permissionsPath: resolve(base, DEFAULT_PERMISSIONS_PATH),
    usersPath: resolve(base, DEFAULT_USERS_PATH),
  };
}

/** Read both policy files once and return a frozen policy. Throws on a missing or malformed file. */
export function loadPolicy(options = {}) {
  const base = defaultPolicyBaseDir();
  const permissionsPath = resolve(base, nonEmpty(options.permissionsPath) ?? DEFAULT_PERMISSIONS_PATH);
  const usersPath = resolve(base, nonEmpty(options.usersPath) ?? DEFAULT_USERS_PATH);
  const permissions = readJson(permissionsPath);
  const roster = readJson(usersPath);

  const identities = Object.create(null);
  for (const [key, email] of Object.entries(plainObject(permissions.identities, `${permissionsPath}: identities`))) {
    if (!nonEmpty(email)) {
      throw new Error(`${permissionsPath}: identities.${key} must map to a users.json email`);
    }
    identities[key] = email;
  }
  const grants = plainObject(permissions.grants, `${permissionsPath}: grants`);
  for (const [role, byAgent] of Object.entries(grants)) {
    for (const [agent, byTool] of Object.entries(plainObject(byAgent, `${permissionsPath}: grants.${role}`))) {
      for (const [toolName, grant] of Object.entries(plainObject(byTool, `${permissionsPath}: grants.${role}.${agent}`))) {
        validateGrant(grant, `${permissionsPath}: grants.${role}.${agent}.${toolName}`);
      }
    }
  }

  if (!Array.isArray(roster.users)) {
    throw new Error(`${usersPath}: users must be an array`);
  }
  const rolesByEmail = Object.create(null);
  for (const user of roster.users) {
    if (!isPlainObject(user) || !nonEmpty(user.email) || !nonEmpty(user.role)) {
      throw new Error(`${usersPath}: every user needs an email and a role`);
    }
    rolesByEmail[user.email] = user.role;
  }

  return Object.freeze({
    identities: Object.freeze(identities),
    grants,
    rolesByEmail: Object.freeze(rolesByEmail),
    permissionsPath,
    usersPath,
  });
}

/** Map a plugin tool factory context onto the principal input. */
export function fromToolContext(toolContext) {
  return {
    senderId: toolContext?.requesterSenderId,
    channel: toolContext?.messageChannel,
    agentId: toolContext?.agentId,
    sessionKey: toolContext?.sessionKey,
  };
}

/** Map an agent-turn hook context (before_prompt_build and friends) onto the principal input. */
export function fromAgentHookContext(ctx) {
  return {
    senderId: ctx?.senderId,
    channel: ctx?.messageProvider ?? ctx?.channel,
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
  };
}

/** Who is calling: user email and role from the roster, the agent, and the invocation surface. Never throws. */
export function resolvePrincipal(input, policy) {
  const agent = nonEmpty(input?.agentId) ?? null;
  const channel = nonEmpty(input?.channel);
  const senderId = nonEmpty(input?.senderId);
  const sessionKey = nonEmpty(input?.sessionKey) ?? null;
  const surface = sessionKey && sessionKey.includes(SUBAGENT_MARKER) ? SUBAGENT_SURFACE : (channel ?? CLI_SURFACE);
  const identityKey = channel && senderId ? `${channel}:${senderId}` : null;
  const user = identityKey && Object.hasOwn(policy.identities, identityKey) ? policy.identities[identityKey] : null;
  const role = user && Object.hasOwn(policy.rolesByEmail, user) ? policy.rolesByEmail[user] : null;
  return Object.freeze({ user, role, agent, surface, identityKey, sessionKey });
}

/** The grant for this principal and tool, or null. A grant needs a known user, role, agent and a listed surface. */
export function grantFor(principal, policy, toolName) {
  if (!principal.user || !principal.role || !principal.agent) {
    return null;
  }
  const grant = own(own(own(policy.grants, principal.role), principal.agent), toolName);
  if (!isPlainObject(grant) || !Array.isArray(grant.surfaces) || !grant.surfaces.includes(principal.surface)) {
    return null;
  }
  return grant;
}

/** Keys of `fields` that the grant does not list. */
export function deniedFields(grant, fields) {
  if (!isPlainObject(fields)) {
    return [];
  }
  const allowed = Array.isArray(grant.fields) ? grant.fields : [];
  return Object.keys(fields).filter((key) => !allowed.includes(key));
}

/** A denial reason when the write shape falls outside the grant, else null. A capped grant with no usable record count is denied. */
export function checkWriteShape(grant, shape) {
  const bad = deniedFields(grant, shape?.fields);
  if (bad.length > 0) {
    return `fields outside the grant: ${bad.join(", ")}`;
  }
  if (grant.maxRecords !== undefined) {
    const count = shape?.recordCount;
    if (!isNonNegativeInteger(count)) {
      return `the grant caps records at ${grant.maxRecords} but the tool reported no record count`;
    }
    if (count > grant.maxRecords) {
      return `${count} records exceeds the grant cap of ${grant.maxRecords}`;
    }
  }
  return null;
}

/**
 * Build a write tool for one runtime context. Returns null when the caller has
 * no grant, so the model never sees the tool. Otherwise the returned tool checks
 * the write shape against the grant on every call before running it.
 */
export function guardWrite({ toolContext, policy, tool }) {
  const principal = resolvePrincipal(fromToolContext(toolContext), policy);
  const grant = grantFor(principal, policy, tool.name);
  if (!grant) {
    return null;
  }
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      const shape = tool.shape ? tool.shape(params) : { fields: params?.fields };
      const reason = checkWriteShape(grant, shape);
      if (reason) {
        throw new Error(`${tool.name} denied for ${principal.user}: ${reason}`);
      }
      return toToolResult(await tool.run(params, { principal, grant, toolCallId, signal, onUpdate }));
    },
  };
}

// Same shape the SDK's own textResult and jsonResult helpers produce.
function toToolResult(value) {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }], details: value };
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`policy file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function own(container, key) {
  return isPlainObject(container) && typeof key === "string" && Object.hasOwn(container, key) ? container[key] : undefined;
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

// A malformed grant fails loud at load time instead of silently widening or narrowing at call time.
function validateGrant(grant, label) {
  if (!isPlainObject(grant)) {
    throw new Error(`${label} must be an object`);
  }
  if (!isStringArray(grant.surfaces) || grant.surfaces.length === 0) {
    throw new Error(`${label}.surfaces must be a non-empty array of surface names`);
  }
  if (grant.fields !== undefined && !isStringArray(grant.fields)) {
    throw new Error(`${label}.fields must be an array of field names`);
  }
  if (grant.maxRecords !== undefined && !isNonNegativeInteger(grant.maxRecords)) {
    throw new Error(`${label}.maxRecords must be a non-negative integer`);
  }
}
