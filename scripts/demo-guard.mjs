#!/usr/bin/env node
// Shows the permission guard in plugins/policy-core on the real config/permissions.json and
// config/users.json. A grant is one entry in permissions.json that lets one role use one tool.
// It builds a write tool for six callers and prints whether each is allowed, denied or never offered.
// No install and no gateway needed:
//   node scripts/demo-guard.mjs
import { fileURLToPath } from "node:url";
import { guardWrite, loadPolicy } from "../plugins/policy-core/index.js";

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const policy = loadPolicy({ permissionsPath: file("../config/permissions.json"), usersPath: file("../config/users.json") });

const update = { name: "salesforce_update_account", description: "Update one account.", parameters: {}, run: () => "ok" };
const bulk = {
  name: "salesforce_bulk_update_accounts",
  description: "Update many accounts.",
  parameters: {},
  shape: ({ accountIds, fields }) => ({ fields, recordCount: accountIds.length }),
  run: () => "ok",
};
const ids = (n) => Array.from({ length: n }, (_, i) => `acc_${1000 + i}`);

async function attempt(who, sender, what, tool, params) {
  const toolContext = { requesterSenderId: sender, messageChannel: "slack", agentId: "sales", sessionKey: "agent:sales:demo" };
  const built = guardWrite({ toolContext, policy, tool });
  let result = "tool not offered";
  if (built) {
    try {
      await built.execute("demo", params);
      result = "ALLOWED";
    } catch (error) {
      result = `DENIED, ${error.message.split(": ").slice(1).join(": ")}`;
    }
  }
  console.log(`${who.padEnd(8)} ${what.padEnd(22)} ${result}`);
}

await attempt("Marcus", "U0MARCUS", "update {stage}", update, { accountId: "acc_1001", fields: { stage: "negotiation" } });
await attempt("Marcus", "U0MARCUS", "update {owner}", update, { accountId: "acc_1001", fields: { owner: "sales-team" } });
await attempt("Marcus", "U0MARCUS", "bulk update", bulk, { accountIds: ids(3), fields: { owner: "sales-team" } });
await attempt("Jordan", "U0JORDAN", "bulk of 25", bulk, { accountIds: ids(25), fields: { owner: "sales-team" } });
await attempt("Jordan", "U0JORDAN", "bulk of 26", bulk, { accountIds: ids(26), fields: { owner: "sales-team" } });
await attempt("Unknown", "U0NOBODY", "any write", update, { accountId: "acc_1001", fields: { stage: "won" } });
