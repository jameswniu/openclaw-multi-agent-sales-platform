#!/usr/bin/env node
// Load test for the gateway: N concurrent chat turns through the OpenAI-compatible
// endpoint. The endpoint is stateless per request (a fresh session key each call),
// so N requests in flight is N users typing at once.
//
// Managed mode (default) starts its own mock LLM and gateway on private ports from
// the given config, in a fresh state directory per run, so a stack you already have
// running is never touched:
//   node scripts/load-test.mjs
//   node scripts/load-test.mjs --config /tmp/baseline.json
// Pass --plugin ./plugins/salesforce (built as README.md describes) to install the
// Salesforce plugin into that run, so "look up acc_1001" is a real tool turn. Without
// it the agent answers with canned text and a turn is a single model call, which the
// output labels.
// External mode targets a stack you started yourself. That gateway needs
// gateway.http.endpoints.chatCompletions.enabled set to true:
//   node scripts/load-test.mjs --external --gateway http://127.0.0.1:18789 --mock http://127.0.0.1:4123
//
// Phases, in order: burst (50 then 300 concurrent), soak (closed loop at 50 for
// 60s), then ratelimit (flip the mock's 429 on and time how long a caller waits for
// an answer). The ratelimit phase runs last so that whatever the gateway does after
// a rate-limit failure cannot distort the other measurements.
//
// The mock answers in 350ms by default, which is far faster than any real model
// turn. The test sets it to 3s through the mock's admin endpoint so the gateway's
// lane slots actually wait on the vendor, the way they do in production. Pass
// --mock-delay-ms 350 to measure at the mock's own default.
//
// Latencies are measured over every caller, failures included, and percentiles use
// the upper nearest rank. Exit code 1 when the 50-user burst has errors or its p95
// exceeds the bound, when any 300-user caller waits longer than the run-timeout
// bound (an answer or a fast failure inside the deadline is the pass condition
// there), when the rate-limited caller does not see an HTTP 429 inside the
// ratelimit bound, or when the first caller after the 429 clears gets no answer.
// Bounds and ports are flags, see FLAGS below for the names.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const FLAGS = {
  config: { kind: "string", fallback: "openclaw.json" },
  external: { kind: "boolean" },
  gateway: { kind: "string", fallback: "http://127.0.0.1:18999" },
  mock: { kind: "string", fallback: "http://127.0.0.1:4199" },
  agent: { kind: "string", fallback: "sales" },
  message: { kind: "string", fallback: "look up acc_1001" },
  plugin: { kind: "string", fallback: "" },
  users: { kind: "string", fallback: "50,300" },
  "soak-seconds": { kind: "number", fallback: 60 },
  "soak-users": { kind: "number", fallback: 50 },
  "p95-50": { kind: "number", fallback: 40_000 },
  "max-300": { kind: "number", fallback: 130_000 },
  "request-timeout": { kind: "number", fallback: 150_000 },
  "ratelimit-max-ms": { kind: "number", fallback: 120_000 },
  "ratelimit-user": { kind: "string", fallback: "" },
  "mock-delay-ms": { kind: "number", fallback: 3000 },
  "skip-burst": { kind: "boolean" },
  "skip-soak": { kind: "boolean" },
  "skip-ratelimit": { kind: "boolean" },
};
const FLAG_PREFIX = "-".repeat(2);

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const opts = {
  config: path.resolve(args.config),
  external: args.external,
  gateway: args.gateway,
  mock: args.mock,
  agent: args.agent,
  message: args.message,
  plugin: args.plugin ? path.resolve(args.plugin) : "",
  users: args.users.split(",").map(parseUsers),
  soakSeconds: args["soak-seconds"],
  soakUsers: args["soak-users"],
  p95: { 50: args["p95-50"] },
  maxWait: { 300: args["max-300"] },
  requestTimeoutMs: args["request-timeout"],
  ratelimitMaxMs: args["ratelimit-max-ms"],
  // A stable OpenAI `user` makes the gateway persist the session for the
  // rate-limited caller, which is what a Control UI chat looks like.
  ratelimitUser: args["ratelimit-user"],
  mockDelayMs: args["mock-delay-ms"],
  skipBurst: args["skip-burst"],
  skipSoak: args["skip-soak"],
  skipRatelimit: args["skip-ratelimit"],
};

const children = [];
let runDir = "";
let rateLimitArmed = false;
let stopping = false;
let failed = false;

process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));

try {
  if (!opts.external) await startManagedStack();
  await waitForHealth();
  await setMockDelay(opts.mockDelayMs);
  console.log(`gateway ${opts.gateway}  mock ${opts.mock}  agent ${opts.agent}  config ${opts.config}  mock delay ${opts.mockDelayMs}ms`);
  if (!opts.external) console.log(`plugins loaded by the gateway: ${readLoadedPlugins()}`);

  for (const n of opts.skipBurst ? [] : opts.users) {
    const stats = await burst(n);
    const p95Bound = opts.p95[n];
    const maxBound = opts.maxWait[n];
    let boundText = "no bound";
    if (p95Bound) {
      const ok = !stats.failed && stats.p95 <= p95Bound;
      boundText = `zero errors and p95 bound ${p95Bound}ms ${ok ? "ok" : "EXCEEDED"}`;
      if (!ok) failed = true;
    } else if (maxBound) {
      const ok = stats.max <= maxBound;
      boundText = `every caller done within ${maxBound}ms ${ok ? "ok" : "EXCEEDED"}`;
      if (!ok) failed = true;
    }
    console.log(`burst ${n}: ok ${stats.ok} errors ${stats.errors} p50 ${stats.p50}ms p95 ${stats.p95}ms max ${stats.max}ms wall ${stats.wall}ms  ${boundText}`);
  }

  if (!opts.skipSoak) {
    const stats = await soak(opts.soakUsers, opts.soakSeconds);
    if (stats.failed) failed = true;
    console.log(`soak ${opts.soakUsers} users ${opts.soakSeconds}s: ok ${stats.ok} errors ${stats.errors} p50 ${stats.p50}ms p95 ${stats.p95}ms max ${stats.max}ms throughput ${stats.rps}/s`);
  }

  if (!opts.skipRatelimit) await ratelimit();

  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  await stop(failed ? 1 : 0);
} catch (err) {
  console.error(`load test aborted: ${err instanceof Error ? err.message : String(err)}`);
  await stop(2);
}

async function burst(n) {
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: n }, () => request()));
  return summarize(results, Date.now() - started);
}

async function soak(users, seconds) {
  const deadline = Date.now() + seconds * 1000;
  const started = Date.now();
  const results = [];
  const worker = async () => {
    while (Date.now() < deadline) results.push(await request());
  };
  await Promise.all(Array.from({ length: users }, worker));
  const stats = summarize(results, Date.now() - started);
  stats.rps = (results.length / ((Date.now() - started) / 1000)).toFixed(1);
  return stats;
}

async function ratelimit() {
  await setRateLimit(true);
  const first = await request(opts.ratelimitMaxMs + 10_000, opts.ratelimitUser);
  const firstText = first.ok
    ? "answered 200 despite the 429 (unexpected)"
    : first.timedOut
      ? `still waiting after ${first.ms}ms (HUNG)`
      : `saw status ${first.status || first.error} after ${first.ms}ms`;
  const withinBound = first.status === 429 && first.ms <= opts.ratelimitMaxMs;
  if (!withinBound) failed = true;
  console.log(`ratelimit: caller during 429 ${firstText}  HTTP 429 within ${opts.ratelimitMaxMs}ms ${withinBound ? "ok" : "EXCEEDED"}`);
  await setRateLimit(false);
  const second = await request(opts.requestTimeoutMs);
  if (!second.ok) failed = true;
  const secondText = second.ok
    ? `answered in ${second.ms}ms ok`
    : second.timedOut
      ? `still waiting after ${second.ms}ms, the gateway did not recover (FAILED)`
      : `saw status ${second.status || second.error} after ${second.ms}ms (FAILED)`;
  console.log(`ratelimit: caller after 429 cleared ${secondText}`);
}

async function request(timeoutMs = opts.requestTimeoutMs, user = "") {
  const started = Date.now();
  try {
    const res = await fetch(`${opts.gateway}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `openclaw/${opts.agent}`,
        stream: false,
        messages: [{ role: "user", content: opts.message }],
        ...(user ? { user } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return { ms: Date.now() - started, status: res.status, ok: res.ok && body.length > 0, timedOut: false };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const error = cause instanceof Error ? cause.code ?? cause.message : String(cause);
    return { ms: Date.now() - started, status: 0, ok: false, timedOut, error };
  }
}

function summarize(results, wall) {
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const pick = (q) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)] ?? 0;
  const failures = results.filter((r) => !r.ok);
  const kinds = new Map();
  for (const r of failures) {
    const kind = r.timedOut ? "client-timeout" : r.status ? `http-${r.status}` : `transport ${r.error ?? ""}`.trim();
    const entry = kinds.get(kind) ?? { count: 0, firstMs: r.ms, lastMs: r.ms };
    entry.count += 1;
    entry.firstMs = Math.min(entry.firstMs, r.ms);
    entry.lastMs = Math.max(entry.lastMs, r.ms);
    kinds.set(kind, entry);
  }
  const errorText = failures.length
    ? ` (${[...kinds].map(([k, v]) => `${k} x${v.count} between ${v.firstMs}ms and ${v.lastMs}ms`).join(", ")})`
    : "";
  return {
    ok: results.length - failures.length,
    errors: `${failures.length}${errorText}`,
    failed: failures.length > 0,
    p50: pick(0.5),
    p95: pick(0.95),
    max: latencies.at(-1) ?? 0,
    wall,
  };
}

async function setMockDelay(ms) {
  await mockAdmin("/admin/delay", { ms });
}

async function setRateLimit(enabled) {
  // Arm before enabling and disarm only after a confirmed disable, so a lost
  // response to the enable call still leaves cleanup switching the 429 back off.
  if (enabled) rateLimitArmed = true;
  await mockAdmin("/admin/rate-limit", { enabled });
  if (!enabled) rateLimitArmed = false;
}

async function mockAdmin(pathname, body) {
  const res = await fetch(`${opts.mock}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`mock ${pathname} returned ${res.status}`);
}

async function startManagedStack() {
  const mockPort = Number(new URL(opts.mock).port);
  const gatewayPort = Number(new URL(opts.gateway).port);
  for (const port of [mockPort, gatewayPort]) {
    if (await portInUse(port)) throw new Error(`port ${port} is already in use, stop that process or pick another port`);
  }
  runDir = path.join(repoRoot, ".openclaw-home", "loadtest", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  fs.mkdirSync(path.join(runDir, "state"), { recursive: true });

  // The committed config stays untouched. The overlay only turns on the HTTP
  // endpoint the test needs, points the mock provider at the private mock port,
  // and pins agent workspaces to absolute paths.
  const cfg = JSON.parse(fs.readFileSync(opts.config, "utf8"));
  const http = cfg.gateway?.http ?? {};
  const endpoints = http.endpoints ?? {};
  cfg.gateway = { ...cfg.gateway, http: { ...http, endpoints: { ...endpoints, chatCompletions: { ...(endpoints.chatCompletions ?? {}), enabled: true } } } };
  if (!cfg.models?.providers?.mock) throw new Error("config has no models.providers.mock entry to point at the mock");
  cfg.models.providers.mock.baseUrl = `${opts.mock}/v1`;
  for (const agent of cfg.agents?.list ?? []) {
    if (agent.workspace && !path.isAbsolute(agent.workspace)) agent.workspace = path.resolve(repoRoot, agent.workspace);
  }
  const overlayPath = path.join(runDir, "openclaw.json");
  fs.writeFileSync(overlayPath, JSON.stringify(cfg, null, 2));

  const gatewayEnv = {
    ...process.env,
    OPENCLAW_HOME: runDir,
    OPENCLAW_STATE_DIR: path.join(runDir, "state"),
    OPENCLAW_CONFIG_PATH: overlayPath,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
  };
  const openclaw = path.join(repoRoot, "node_modules", "openclaw", "openclaw.mjs");
  if (opts.plugin) await installPlugin(openclaw, gatewayEnv);

  const logs = fs.openSync(path.join(runDir, "gateway.log"), "w");
  const gatewayArgs = ["gateway", "--auth", "none", "--bind", "loopback", "--allow-unconfigured"];
  const mock = spawn(process.execPath, [path.join(repoRoot, "mock-llm", "server.js")], {
    env: { ...process.env, PORT: String(mockPort) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const gateway = spawn(process.execPath, [openclaw, ...gatewayArgs], { cwd: repoRoot, env: gatewayEnv, stdio: ["ignore", logs, logs] });
  for (const [name, child] of [["mock", mock], ["gateway", gateway]]) {
    children.push(child);
    child.on("error", (err) => {
      console.error(`${name} failed to start: ${err.message}`);
      void stop(2);
    });
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(`${name} exited early (code ${code}, signal ${signal}), see ${path.join(runDir, "gateway.log")}`);
        void stop(2);
      }
    });
  }
  console.log(`managed stack: mock pid ${mock.pid}, gateway pid ${gateway.pid}, run dir ${runDir}`);
}

async function installPlugin(openclaw, env) {
  const install = spawn(process.execPath, [openclaw, "plugins", "install", opts.plugin], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  install.stdout.on("data", (chunk) => (output += chunk));
  install.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    install.on("error", reject);
    install.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`plugin install of ${opts.plugin} exited ${code}:\n${output.trim()}`);
}

function readLoadedPlugins() {
  const log = fs.readFileSync(path.join(runDir, "gateway.log"), "utf8");
  const match = /http server listening \((\d+) plugins?: ([^)]*)\)/.exec(log);
  return match ? match[2] : "unknown (no listening line in gateway.log)";
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${opts.gateway}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      if (err instanceof TypeError && /Invalid URL/i.test(lastError)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`gateway at ${opts.gateway} did not report healthy within 90s (last error: ${lastError})`);
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (rateLimitArmed) {
    try {
      await setRateLimit(false);
    } catch (err) {
      console.error(`could not switch the mock's rate limit back off: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  process.exit(code);
}

function parseUsers(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${FLAG_PREFIX}users needs positive integers, got "${value}"`);
  return n;
}

function parseArgs(argv) {
  const out = {};
  for (const [name, spec] of Object.entries(FLAGS)) out[name] = spec.kind === "boolean" ? false : spec.fallback;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith(FLAG_PREFIX) || arg.length <= 2) throw new Error(`unexpected argument "${arg}"`);
    const [key, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const spec = FLAGS[key];
    if (!spec) throw new Error(`unknown flag ${FLAG_PREFIX}${key}`);
    if (spec.kind === "boolean") {
      out[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`${FLAG_PREFIX}${key} needs a value`);
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${FLAG_PREFIX}${key} needs a non-negative number, got "${value}"`);
      out[key] = n;
    } else {
      out[key] = value;
    }
  }
  return out;
}
