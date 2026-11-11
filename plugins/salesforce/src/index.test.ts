// Vitest check that the Salesforce plugin in index.ts declares the expected tool names.

import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("salesforce", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "salesforce_list_accounts",
      "salesforce_get_account",
      "salesforce_update_account",
      "salesforce_bulk_update_accounts",
    ]);
  });
});
