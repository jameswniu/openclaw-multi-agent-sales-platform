// Salesforce plugin for the OpenClaw gateway, backed by an in-memory list of fake accounts.
// Two read tools are always offered. The two write tools, update and bulk update, are built per run
// through the shared permission guard in plugins/policy-core, so a caller with no grant never sees them
// and a write outside its grant is refused. A grant is one entry in config/permissions.json.

import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { guardWrite, loadPolicy } from "openclaw-policy-core";

type Account = {
  id: string;
  name: string;
  stage: string;
  arr: number;
  owner: string;
};

const accounts = new Map<string, Account>([
  ["acc_1001", { id: "acc_1001", name: "Northwind Retail", stage: "negotiation", arr: 48000, owner: "sales" }],
  ["acc_1002", { id: "acc_1002", name: "Beacon Logistics", stage: "closed_won", arr: 120000, owner: "sales" }],
  ["acc_1003", { id: "acc_1003", name: "Clearwater Foods", stage: "prospecting", arr: 0, owner: "sales" }],
  ["acc_1004", { id: "acc_1004", name: "Argyle Media", stage: "renewal", arr: 76000, owner: "sales" }],
  ["acc_1005", { id: "acc_1005", name: "Foundry Robotics", stage: "closed_lost", arr: 0, owner: "sales" }],
]);

function getAccount(accountId: string): Account {
  const account = accounts.get(accountId);
  if (!account) {
    throw new Error(`unknown account: ${accountId}`);
  }
  return account;
}

function updateOneAccount(accountId: string, fields: Partial<Omit<Account, "id">>): Account {
  const account = getAccount(accountId);
  const updated = { ...account, ...fields };
  accounts.set(accountId, updated);
  return updated;
}

function updateManyAccounts(
  updates: Array<{ accountId: string; fields: Partial<Omit<Account, "id">> }>,
): Account[] {
  return updates.map(({ accountId, fields }) => {
    const account = getAccount(accountId);
    const updated = { ...account, ...fields };
    accounts.set(accountId, updated);
    return updated;
  });
}

const fieldsSchema = Type.Object({
  stage: Type.Optional(Type.String()),
  arr: Type.Optional(Type.Number()),
  owner: Type.Optional(Type.String()),
});

const updateParams = Type.Object({
  accountId: Type.String({ description: "Account id, e.g. acc_1001." }),
  fields: fieldsSchema,
});

const bulkParams = Type.Object({
  accountIds: Type.Array(Type.String(), { description: "Account ids to update." }),
  fields: fieldsSchema,
});

type UpdateParams = { accountId: string; fields: Partial<Omit<Account, "id">> };
type BulkParams = { accountIds: string[]; fields: Partial<Omit<Account, "id">> };

// Where the write policy lives. Relative paths resolve against the directory
// holding OPENCLAW_CONFIG_PATH, so an installed copy of the plugin still finds
// the repo's config/ folder.
const configSchema = Type.Object(
  {
    permissionsPath: Type.Optional(Type.String({ description: "Path to permissions.json (identities and grants)." })),
    usersPath: Type.Optional(Type.String({ description: "Path to the team roster users.json (email and role)." })),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "salesforce",
  name: "Salesforce",
  description: "Salesforce account lookups and updates (mocked backend).",
  configSchema,
  tools: (tool) => [
    tool({
      name: "salesforce_list_accounts",
      label: "List Accounts",
      description: "List all accounts.",
      parameters: Type.Object({}),
      execute: async () => [...accounts.values()],
    }),
    tool({
      name: "salesforce_get_account",
      label: "Get Account",
      description: "Look up one account by id.",
      parameters: Type.Object({
        accountId: Type.String({ description: "Account id, e.g. acc_1001." }),
      }),
      execute: async ({ accountId }) => getAccount(accountId),
    }),
    // Writes are built per run from the caller's principal: no grant, no tool.
    tool({
      name: "salesforce_update_account",
      label: "Update Account",
      description: "Update fields on one account.",
      parameters: updateParams,
      factory: ({ config, toolContext }) =>
        guardWrite<UpdateParams, typeof updateParams>({
          toolContext,
          policy: loadPolicy(config),
          tool: {
            name: "salesforce_update_account",
            label: "Update Account",
            description: "Update fields on one account.",
            parameters: updateParams,
            run: ({ accountId, fields }) => updateOneAccount(accountId, fields),
          },
        }),
    }),
    tool({
      name: "salesforce_bulk_update_accounts",
      label: "Bulk Update Accounts",
      description: "Apply the same field updates across multiple accounts.",
      parameters: bulkParams,
      factory: ({ config, toolContext }) =>
        guardWrite<BulkParams, typeof bulkParams>({
          toolContext,
          policy: loadPolicy(config),
          tool: {
            name: "salesforce_bulk_update_accounts",
            label: "Bulk Update Accounts",
            description: "Apply the same field updates across multiple accounts.",
            parameters: bulkParams,
            shape: ({ accountIds, fields }) => ({ fields, recordCount: accountIds.length }),
            run: ({ accountIds, fields }) => accountIds.map((accountId) => updateOneAccount(accountId, fields)),
          },
        }),
    }),
  ],
});

export { updateManyAccounts };
