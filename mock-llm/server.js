#!/usr/bin/env node
// Minimal OpenAI-compatible /v1/chat/completions mock. No real model, no API key,
// no network calls out. Point openclaw's models.providers.mock.baseUrl at this.
//
// Replies are deterministic. When the request carries tool schemas and the last
// user message mentions an account id (acc_NNNN), the mock emits tool calls the
// way a production model would; otherwise it answers with canned text in the
// agent's voice.

const http = require("http");

const PORT = Number(process.env.PORT || 4123);

const state = {
  delayMs: Number(process.env.MOCK_DELAY_MS || 350),
  rateLimited: false,
};

const REPLIES = {
  "mock-router": [
    "Got it, routing this to the right specialist now.",
    "That's outside what I handle directly, let me hand this off.",
    "I can take this one myself, one sec.",
  ],
  "mock-marketing": [
    "On it, pulling the campaign numbers now.",
    "Here's the read: creative fatigue is the bigger factor than audience size.",
    "I'll draft that and share it before anything goes out.",
  ],
  "mock-sales": [
    "Pulling the account data now, one sec.",
    "This deal's stalled for three weeks, here's what I'd try next.",
    "Happy to dig in, give me an account id and I'll pull it up.",
  ],
  "mock-ads": [
    "CPL's up but CVR's steady, that's auction pressure, not a real problem.",
    "This one's ready to scale, want me to build the next ad set?",
    "Flagging frequency creeping up on the top campaign.",
  ],
  "mock-auditor": [
    "Checked the pipeline against the CRM, two quotes don't match their opportunities.",
    "Give me an account id and I'll pull what the CRM has on it.",
    "Renewal risk flag: usage dropped 40% in the last 30 days, no CS touch logged.",
  ],
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part && part.text) || ""))
      .join(" ");
  }
  return "";
}

function pickReply(model, messages) {
  const bucket = REPLIES[model] || REPLIES["mock-router"];
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
  const seed = textOf(lastUser?.content).length + (messages || []).length;
  return bucket[seed % bucket.length];
}

function planToolCalls(body) {
  const toolNames = new Set(
    (body.tools || []).map((t) => t?.function?.name).filter(Boolean),
  );
  if (toolNames.size === 0) return null;

  const messages = body.messages || [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;

  const text = textOf(last.content);
  if (toolNames.has("memory_recall") && /(?:^|\n)\s*(?:what do you remember|recall)\b/i.test(text)) {
    return [{ name: "memory_recall", args: {} }];
  }
  const rememberThat = /(?:^|\n)\s*remember that\s+([^\n]+)/i.exec(text);
  if (rememberThat && toolNames.has("memory_remember")) {
    return [{ name: "memory_remember", args: { note: rememberThat[1].trim() } }];
  }
  const ids = [...text.matchAll(/\bacc_\d+\b/g)].map((m) => m[0]);
  const wantsWrite = /\b(update|set|change|move|mark|bump|close)\b/i.test(text);
  const stage = /stage (?:to|=|as) ?"?([a-z0-9_-]+)"?/i.exec(text)?.[1];
  const owner = /owner (?:to|=|as) ?"?([a-z0-9_-]+)"?/i.exec(text)?.[1];
  const bulk =
    ids.length > 1 || /\b(all|every|each|bulk|these)\b[^.]*\baccounts?\b/i.test(text);
  const targetIds = ids.length
    ? ids
    : bulk
      ? ["acc_1001", "acc_1002", "acc_1003"]
      : [];

  if (wantsWrite && targetIds.length && toolNames.has("salesforce_update_account")) {
    const fields = {};
    if (stage) fields.stage = stage;
    if (owner) fields.owner = owner;
    if (Object.keys(fields).length === 0) fields.stage = "closed_won";
    return targetIds.map((accountId) => ({
      name: "salesforce_update_account",
      args: { accountId, fields },
    }));
  }
  if (ids.length && toolNames.has("salesforce_get_account")) {
    return [{ name: "salesforce_get_account", args: { accountId: ids[0] } }];
  }
  if (/\b(list|show)\b[^.]*\baccounts\b/i.test(text) && toolNames.has("salesforce_list_accounts")) {
    return [{ name: "salesforce_list_accounts", args: {} }];
  }
  return null;
}

function toolResultReply(messages) {
  let count = 0;
  let lastContent = "";
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i -= 1) {
    count += 1;
    lastContent = textOf(messages[i].content) || lastContent;
  }
  const snippet = lastContent.replace(/\s+/g, " ").slice(0, 300);
  const plural = count === 1 ? "call" : "calls";
  return `Done, ${count} tool ${plural} came back. Latest result: ${snippet}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function completionEnvelope(model) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: "chatcmpl-mock-" + created + "-" + Math.random().toString(36).slice(2, 8),
    created,
    model,
  };
}

function textPayload(model, text) {
  const { id, created } = completionEnvelope(model);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
  };
}

function toolCallsPayload(model, calls) {
  const { id, created } = completionEnvelope(model);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, k) => ({
            id: `call_${created}_${k}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function startStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function streamText(res, model, text) {
  startStream(res);
  const { id, created } = completionEnvelope(model);
  const words = text.split(" ");
  const send = (delta, finishReason) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  send({ role: "assistant", content: "" }, null);
  let i = 0;
  const interval = setInterval(() => {
    if (i >= words.length) {
      clearInterval(interval);
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send({ content: (i === 0 ? "" : " ") + words[i] }, null);
    i += 1;
  }, 25);
}

function streamToolCalls(res, model, calls) {
  startStream(res);
  const { id, created } = completionEnvelope(model);
  const send = (delta, finishReason) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  send({ role: "assistant" }, null);
  calls.forEach((call, k) => {
    send(
      {
        tool_calls: [
          {
            index: k,
            id: `call_${created}_${k}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      },
      null,
    );
  });
  send({}, "tool_calls");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, {
      error: { message: "invalid json", type: "invalid_request_error" },
    });
  }

  const model = body.model || "mock-router";

  if (state.rateLimited) {
    return sendJson(res, 429, {
      error: {
        message: "429 Rate limit exceeded: free-models-per-day-high-balance.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
  }

  const messages = body.messages || [];
  const last = messages[messages.length - 1];

  const respond = () => {
    if (last && last.role === "tool") {
      const text = toolResultReply(messages);
      return body.stream ? streamText(res, model, text) : sendJson(res, 200, textPayload(model, text));
    }
    const calls = planToolCalls(body);
    if (calls) {
      return body.stream
        ? streamToolCalls(res, model, calls)
        : sendJson(res, 200, toolCallsPayload(model, calls));
    }
    const text = pickReply(model, messages);
    return body.stream ? streamText(res, model, text) : sendJson(res, 200, textPayload(model, text));
  };

  setTimeout(respond, state.delayMs);
}

function handleModels(_req, res) {
  const now = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: "list",
    data: Object.keys(REPLIES).map((id) => ({ id, object: "model", created: now, owned_by: "mock" })),
  });
}

async function handleAdmin(req, res, pathname) {
  if (pathname === "/admin/status") {
    return sendJson(res, 200, state);
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "POST only" });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  if (pathname === "/admin/rate-limit") {
    state.rateLimited = Boolean(body.enabled);
    return sendJson(res, 200, state);
  }
  if (pathname === "/admin/delay") {
    if (typeof body.ms === "number") state.delayMs = body.ms;
    return sendJson(res, 200, state);
  }
  return sendJson(res, 404, { error: "unknown admin endpoint" });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }
  if (pathname === "/v1/models" && req.method === "GET") {
    return handleModels(req, res);
  }
  if (pathname.startsWith("/admin/")) {
    return handleAdmin(req, res, pathname);
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`mock LLM listening on http://127.0.0.1:${PORT}`);
  console.log(
    `toggle rate limiting: curl -X POST http://127.0.0.1:${PORT}/admin/rate-limit -d '{"enabled":true}' -H 'content-type: application/json'`,
  );
});
