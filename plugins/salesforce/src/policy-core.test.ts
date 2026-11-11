// Vitest suite for plugins/policy-core, the shared permission guard. It feeds the guard grant files with
// typical config mistakes and checks that each one fails at load time or is refused at call time,
// never allowed. A grant is one entry in a permissions file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWriteShape, guardWrite, loadPolicy } from "openclaw-policy-core";

// Grants that a config typo could produce. Every one of them must fail loud at
// load time or fail closed at call time, never fail open.
function policyDir(grant: Record<string, unknown>): { permissionsPath: string; usersPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "policy-core-"));
  const permissionsPath = join(dir, "permissions.json");
  const usersPath = join(dir, "users.json");
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      identities: { "slack:U1": "writer@northwind.example" },
      grants: { writer: { sales: { bulk: grant } } },
    }),
  );
  writeFileSync(usersPath, JSON.stringify({ users: [{ email: "writer@northwind.example", role: "writer" }] }));
  return { permissionsPath, usersPath };
}

const writerOnSlack = { requesterSenderId: "U1", messageChannel: "slack", agentId: "sales", sessionKey: "agent:sales:main" };

describe("policy-core grant validation", () => {
  it("rejects a string maxRecords at load time", () => {
    expect(() => loadPolicy(policyDir({ surfaces: ["slack"], fields: ["owner"], maxRecords: "25" }))).toThrow(/maxRecords/);
  });

  it("rejects a grant with no surfaces at load time", () => {
    expect(() => loadPolicy(policyDir({ surfaces: [], fields: ["owner"] }))).toThrow(/surfaces/);
  });

  it("rejects a non-array fields list at load time", () => {
    expect(() => loadPolicy(policyDir({ surfaces: ["slack"], fields: "owner" }))).toThrow(/fields/);
  });

  it("denies a capped write when the tool omits the shape callback", async () => {
    const policy = loadPolicy(policyDir({ surfaces: ["slack"], fields: ["owner"], maxRecords: 25 }));
    let ran = false;
    const tool = guardWrite({
      toolContext: writerOnSlack,
      policy,
      tool: {
        name: "bulk",
        description: "bulk write",
        parameters: {},
        run: () => {
          ran = true;
          return { ok: true };
        },
      },
    });
    expect(tool).not.toBeNull();
    await expect(tool!.execute("call_1", { accountIds: Array.from({ length: 26 }, (_, i) => `acc_${i}`), fields: { owner: "x" } })).rejects.toThrow(/caps records/);
    expect(ran).toBe(false);
  });

  it("denies any field when the grant lists none", () => {
    expect(checkWriteShape({ surfaces: ["slack"] }, { fields: { stage: "won" } })).toMatch(/stage/);
  });
});
