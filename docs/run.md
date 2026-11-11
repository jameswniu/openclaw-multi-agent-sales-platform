# Running the gateway

This file shows how to build the plugins, start the mock model and the gateway, and try an agent, which the Quick start in the README does not do.

## Set the state folders

In every terminal, point OpenClaw's state at the repo instead of your home directory. Do this before `npm install`, since the package writes state on install.

```bash
export OPENCLAW_HOME="$PWD/.openclaw-home"
export OPENCLAW_STATE_DIR="$PWD/.openclaw-home/state"
export OPENCLAW_CONFIG_PATH="$PWD/openclaw.json"
```

The permission files are resolved from the folder that holds `OPENCLAW_CONFIG_PATH`. Keep all three exports set.

## Install and build the plugins

```bash
npm install
cd plugins/salesforce
npm install && npm run build
npx openclaw plugins build --entry ./dist/index.js
cd ../..
npx openclaw plugins install ./plugins/salesforce
```

Repeat the build and install for `plugins/partnerstack` and `plugins/user-memory`. This can stop on the repo's own `openclaw.json` under the pinned CLI version.

After you edit `plugins/policy-core`, run `rm -rf node_modules/openclaw-policy-core && npm install` inside each plugin that depends on it, since npm skips an unchanged version.

## Start it

Run each command in its own terminal.

```bash
npm run mock-llm
npm run gateway
```

The gateway runs with `auth none`, bound to loopback. That is for a local demo only. Do not expose it on a network.

Then open the chat page, or ask an agent from the command line.

```bash
npx openclaw dashboard --no-open
npx openclaw agent --agent sales --message "look up acc_1001"
```

Good prompts to try are `list the accounts`, `look up acc_1002`, `update acc_1001 stage to negotiation` and `update all accounts, set owner to sales-team`. The bulk write is where the permission guard acts.

## Mock server controls

The mock model listens on `127.0.0.1:4123`. Two admin calls change its behavior.

- **Rate limit:** `POST /admin/rate-limit` with `{"enabled": true}` makes it answer 429, which is the status for too many requests.
- **Delay:** `POST /admin/delay` with `{"ms": 500}` adds latency to each reply.

## Checks that need the gateway

- **Two-user memory check:** `node plugins/user-memory/scripts/two-user-check.mjs` needs a built `dist/`, the gateway and the plugin installed.
- **Load test:** `node scripts/load-test.mjs` starts its own mock and gateway on private ports. Run it by hand, never in CI, because its pass bounds depend on wall-clock time. `--users 50 --skip-soak` shortens it.
