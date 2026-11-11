# PartnerStack

OpenClaw tool plugin for PartnerStack (Vendor API v2), following the shape of `plugins/salesforce`. The default backend is an in-memory mock built from the public docs, so nothing here needs an account, a token or a sandbox.

## Build

```bash
npm install
npm run build
npm test
```

`openclaw plugins build` and `openclaw plugins validate` only understand `defineToolPlugin` entries. This plugin needs `definePluginEntry` for its hook, so the manifest is hand-written and a unit test keeps it in step with the config schema and the tool names.

## What it registers

Five read tools, always offered, `partnerstack_list_partnerships`, `partnerstack_get_partnership`, `partnerstack_list_customers`, `partnerstack_list_rewards` and `partnerstack_list_transactions`.

Three money writes, single record only, marked optional so they must be allowlisted, `partnerstack_create_reward`, `partnerstack_create_transaction` and `partnerstack_delete_transaction`. They are built per run through the permission model's `openclaw-policy-core` package, which resolves the person from the trusted sender on the run and returns no tool at all when that person holds no grant for the tool on that agent. The grant lists every field the write may carry, and the request's own keys are checked against it. The package is a `file:../policy-core` dependency copied in at install time (`.npmrc` sets `install-links=true`), the same wiring as `plugins/salesforce`, and `src/integration.test.ts` drives all three writes through the real `resolvePrincipal` and `guardWrite` over copies of the repo's `config/users.json` and `config/permissions.json`.

## How a money write goes through

1. The `before_tool_call` hook checks the money shape (amount at or under `maxWriteCents`, reward target type in `allowedTargets`, exactly one customer reference on a transaction, metadata within the documented limits), records an authorize row keyed by the host's tool call id with a fresh authorization id, and asks the person for approval with severity critical, deny on timeout, allow-once or deny only. The decision row carries that same id, so a later prompt for the same call id can never borrow an earlier decision.
2. The tool's execute refuses unless that row exists for the same tool, agent, session key, session id and parameter hash, an allow decision was recorded for that exact prompt, and the shape checks pass again.
3. The idempotency key is built from the backend, the canonical base URL, the account, the agent, the person, the tool and the canonical parameters. A prior success with the same key returns the earlier result without calling PartnerStack. A prior send still inside `inflightWindowMs` is refused as in flight. Any older attempt with no authoritative outcome is probed once (`GET /v2/rewards?description=idem=...` or `GET /v2/transactions?transaction_key=...`), accepted only if the record carries our agent, person and idempotency tag with the same amount and currency (the session is attribution only, so a retry from another session still reconciles), and otherwise refused with `UnresolvedWriteError` for a person to resolve. Only an attempt PartnerStack rejected outright may be sent again.
4. The snapshot, the checks and the claim row run inside a pid-owned `mkdir` lock in `ledgerDir`, so neither another tool call on this event loop nor another gateway process sharing the directory can claim the same intent twice. A lock is reclaimed only when its owner process is dead, never because it is old. A 429 backs off with jitter, probes, and only then re-sends. A 2xx without a record key is an unknown outcome, never a cached success.
5. Every reward description and every transaction `metadata` and `stack_key` carry `agent`, `actor`, `session` and the key, because PartnerStack's own `created_by` only ever names the API key owner.
6. Rows `authorize`, `decision`, `sent`, `ok` and `failed` go to `<ledgerDir>/partnerstack-ledger.jsonl`, each fsynced before it returns. A `failed` row records whether the outcome was `rejected` (safe to retry) or `unknown` (never retried automatically). An unreadable row stops money writes with `LedgerCorruptError` until it is repaired by hand.

## Rate limiting and concurrency

Every request goes through one limiter per gateway process, at most `maxConcurrent` in flight, at most `maxRequestsPerMinute` in any rolling 60 seconds (the docs allow 4000 per minute per IP), and a daily counter in `<ledgerDir>/partnerstack-budget.json` that survives restarts, is updated under the same kind of pid-owned lock with an atomic replace, and fails closed with `BudgetExceededError` once `dailyCallBudget` is spent. A counter file with a malformed count or a day that is not a calendar date fails closed too. The docs publish no daily number, so the default of 5000 is an assumption to set per account. A 429 on a read backs off with exponential delay plus jitter, honouring `Retry-After` when present, up to three attempts. Every HTTP request carries the caller's abort signal and a `requestTimeoutMs` deadline, and a call cancelled while queued for a slot or waiting out the pace or a backoff leaves the queue and gives its slot back at once.

## Config

**Warning:** `backend: "http"` calls the live PartnerStack API, and rewards and transactions move real money to partners. The default is the in-memory mock. Use test keys first. Writes still pass through the approval hook (critical severity, denied on timeout) and the grant check.

All keys are optional, see `openclaw.plugin.json`. `backend: "http"` needs credentials. Rewards, transactions and customers are Vendor API endpoints on Basic auth (`authMode: "basic"`, `publicKey` and `secretKey`, or `PARTNERSTACK_PUBLIC_KEY` and `PARTNERSTACK_SECRET_KEY`). `authMode: "bearer"` with `apiKey` is the Partner API. Never put keys in this repo.

## Docs used

- https://docs.partnerstack.com/docs/partner-api (envelope, pagination, epoch ms)
- https://docs.partnerstack.com/reference/auth (Vendor API Basic auth, test versus production keys)
- https://docs.partnerstack.com/reference/rate-limits (4000 per minute per IP, 429)
- https://docs.partnerstack.com/reference/post_v2-rewards and https://docs.partnerstack.com/reference/get_v2-rewards-2
- https://docs.partnerstack.com/reference/post_v2-transactions and https://docs.partnerstack.com/reference/get_v2-transactions-2
- https://docs.partnerstack.com/reference/transaction-metadata (25 attributes, 30-char keys of letters, digits or underscore, 100-char values)
- https://docs.partnerstack.com/reference/get_v2-partnerships-2 and https://docs.partnerstack.com/reference/get_v2-customers-2

## Known limitations

- Two processes that see the same dead lock owner can still overlap. One reclaims the dead lock and takes a fresh one, the other resumes and moves that fresh lock aside, because a rename cannot check whose lock it moves. Both then enter the claim section and could send the same money write twice or lose a budget increment. A fix needs an OS advisory lock that the kernel releases when the holder exits, which Node has no built-in primitive for. Until then, run one gateway process per `ledgerDir` (`src/backend.ts`).
- Reward verification cannot compare the target when PartnerStack's reward object omits it. The documented object carries customer and action fields instead, so a probed record is accepted on agent, actor, idempotency tag, amount and currency alone (`src/index.ts`).
- Transaction verification does not compare the customer. The response carries PartnerStack's internal customer key, while the request may name an external key or an email (`src/index.ts`).
- Cross-gateway safety rests on mkdir and rename over a shared directory, which is not guaranteed atomic on a network filesystem. Two gateways on different hosts must not share a `ledgerDir` (`src/backend.ts`).
- The pace and concurrency caps are per process. Two gateways behind one IP each pace themselves and can together exceed the documented limit (`src/backend.ts`).
- An unresolved write is refused until a person edits the ledger by hand. There is no operator tool for it yet (`src/index.ts`).
- The ledger is parsed in full on every write and never rotated (`src/ledger.ts`).
- The repo's `config/permissions.json` carries no PartnerStack grant, so in the gateway no person is offered a money write until a grant like the one in `src/integration.test.ts` is added for a role and agent.
- The OpenClaw `plugins build`, `validate` and `install` commands could not be run against this entry. Build and validate only accept `defineToolPlugin` entries, and install stops on the repo's own `openclaw.json` under the pinned CLI version, so the manifest is checked by a unit test instead.
- With `backend` left out, the plugin uses the in-memory mock. A write looks successful and nothing reaches PartnerStack, while the approval prompt still says real money moves. A real deployment must set `backend: "http"` on purpose and should refuse to start without it.
- The idempotency key, which stops a repeated request from paying twice, includes the person who asked. If a payment goes through but its answer is lost, a second person retrying the same payment gets a new key and can pay it again. A real deployment should build the key from the payment itself and keep the person only as a record of who asked.
