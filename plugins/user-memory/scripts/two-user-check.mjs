#!/usr/bin/env node
// Two-user no-bleed check through the running gateway.
//
// Needs the mock LLM and the gateway running from the repo root (npm run mock-llm, npm run gateway)
// with the user-memory plugin installed, and the same OPENCLAW_* env exported as in README.md.
//
// Two canonical non-operator gateway client ids stand in for two Control UI users. The gateway stamps
// the client id as the sender, and config/permissions.json maps webchat:webchat to Dana and
// webchat:gateway-client to Marcus. Each line below is printed verbatim from the gateway reply.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveMemoryRootDir } from "../dist/index.js";
import { memoryFilePath } from "../dist/store.js";

const RUN = Date.now().toString(36);
const AGENT = "sales";
const STAND_INS = { dana: "dana.whitfield@northwind.example", marcus: "marcus.oyelaran@northwind.example" };

const USERS = {
  dana: { clientName: "webchat", sessionKey: `agent:sales:demo-dana-${RUN}` },
  marcus: { clientName: "gateway-client", sessionKey: `agent:sales:demo-marcus-${RUN}` },
};

const CLI_OPTS = { timeout: "90000", json: true };

async function rpc(who, method, params) {
  return callGatewayFromCli(method, CLI_OPTS, params, { clientName: USERS[who].clientName, mode: "cli", progress: false });
}

/** The last assistant text in the session, read back from the gateway after the run finished. */
async function lastAssistantText(who) {
  const history = await rpc(who, "chat.history", { sessionKey: USERS[who].sessionKey, limit: 50 });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") {
      continue;
    }
    const text = findText(msg);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function findText(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value.text === "string" && value.type === "text") {
    return value.text;
  }
  for (const key of ["reply", "message", "content", "payload", "result", "final", "assistant", "text"]) {
    const child = value[key];
    if (typeof child === "string" && key !== "type") {
      return child;
    }
    const found = findText(child, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function say(who, message, { freshSession = false } = {}) {
  const user = USERS[who];
  if (freshSession) {
    user.sessionKey = `${user.sessionKey}-again`;
  }
  const sent = await rpc(who, "chat.send", {
    sessionKey: user.sessionKey,
    agentId: "sales",
    message,
    idempotencyKey: randomUUID(),
    deliver: false,
  });
  const runId = typeof sent?.runId === "string" ? sent.runId : undefined;
  if (!runId) {
    throw new Error(`chat.send returned no runId: ${JSON.stringify(sent)}`);
  }
  const waited = await rpc(who, "agent.wait", { runId, timeoutMs: 60000 });
  if (waited?.status !== "ok" && waited?.status !== "completed" && waited?.status !== "done") {
    console.log(`${who} agent.wait -> ${JSON.stringify(waited)}`);
  }
  const text = (await lastAssistantText(who)) ?? `no assistant reply in history after run ${runId}`;
  console.log(`${who} > ${message}`);
  console.log(`${who} < ${text}`);
  console.log("");
  return text;
}

// The check assumes both stand-in users start with empty memory for this agent. It never deletes anything
// silently: existing files stop the run unless --reset-stand-ins is passed, and even then the gateway has to
// answer first so a dead gateway cannot cost anyone their notes.
const RESET_FLAG = "--reset-stand-ins";
const existing = [];
for (const [who, email] of Object.entries(STAND_INS)) {
  const file = memoryFilePath(resolveMemoryRootDir(), AGENT, email);
  const present = await fs.stat(file).then(() => true, () => false);
  if (present) {
    existing.push([who, file]);
  }
}
if (existing.length > 0 && !process.argv.includes(RESET_FLAG)) {
  console.error(`refusing to run, ${existing.map(([who]) => who).join(" and ")} already have sales memory at`);
  for (const [, file] of existing) {
    console.error(`  ${file}`);
  }
  console.error(`re-run with ${RESET_FLAG} to delete exactly those files first`);
  process.exit(2);
}
await rpc("dana", "status", {});
for (const [who, file] of existing) {
  await fs.rm(file, { force: true });
  console.log(`reset ${who}: ${file}`);
}
console.log("");

const failures = [];
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures.push(label);
  }
}

const r1 = await say("dana", "remember that my territory is the west coast");
check("dana remember is acknowledged", /remembered/i.test(r1));

const r2 = await say("marcus", "what do you remember about me");
check("marcus recalls nothing after dana wrote", /nothing remembered/i.test(r2) && !/west coast/i.test(r2));

const r3 = await say("dana", "what do you remember about me");
check("dana recalls her own note", /west coast/i.test(r3));

const r4 = await say("marcus", "remember that my territory is the east coast");
check("marcus remember is acknowledged", /remembered/i.test(r4));

const r5 = await say("dana", "what do you remember about me");
check("dana does not see marcus's note", /west coast/i.test(r5) && !/east coast/i.test(r5));

const r6 = await say("marcus", "what do you remember about me");
check("marcus sees only his own note", /east coast/i.test(r6) && !/west coast/i.test(r6));

const r7 = await say("dana", "what do you remember about me", { freshSession: true });
check("dana recalls her note from a brand new session", /west coast/i.test(r7) && !/east coast/i.test(r7));

console.log("");
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} of 7 checks`);
  process.exit(1);
}
console.log("PASSED 7 of 7 checks, no bleed in either direction, memory survives a new session");
