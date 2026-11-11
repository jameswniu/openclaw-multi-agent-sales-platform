#!/usr/bin/env python3
"""Every number the README and the figures print, read from this repo's own files.

Other tools in tools/ import load() so each number exists in one place only. Run it directly to
print the numbers as a table:

    python3 tools/facts.py

Sources: agents/ and openclaw.json for the agents and the gateway limits, config/users.json and
config/permissions.json for the roster and the write grants, plugins/user-memory/src/store.ts for the
memory cap, and the Vitest JSON reports in .reports/ for the test counts. A report is a file Vitest
writes when run with the json reporter. A grant is one entry in permissions.json that lets one role
use one tool through one agent.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGINS = ("salesforce", "partnerstack", "user-memory")
WRITE_TOOLS = ("salesforce_update_account", "salesforce_bulk_update_accounts")
_CACHE = {}


def _json(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return json.load(f)


def report_hint(plugin):
    return (f"missing .reports/{plugin}.json. Produce it with: mkdir -p .reports && cd plugins/{plugin} && "
            f"npm ci --no-audit --no-fund && npx vitest run --reporter=default --reporter=json "
            f"--outputFile.json=../../.reports/{plugin}.json")


def static_test_count(plugin):
    """Count `it(` and `test(` declarations in the plugin's src/*.test.ts files."""
    src = os.path.join(ROOT, "plugins", plugin, "src")
    n = 0
    for name in sorted(os.listdir(src)):
        if name.endswith(".test.ts"):
            with open(os.path.join(src, name)) as f:
                n += len(re.findall(r"^\s*(?:it|test)\(", f.read(), re.M))
    return n


def load():
    """Return the facts dict. Exits with a message that names the fix when an input is missing."""
    if "facts" in _CACHE:
        return _CACHE["facts"]
    cfg = _json("openclaw.json")
    users = _json("config/users.json")["users"]
    perms = _json("config/permissions.json")
    agents = sorted(d for d in os.listdir(os.path.join(ROOT, "agents")) if os.path.isdir(os.path.join(ROOT, "agents", d)))
    cfg_agents = sorted(a["id"] for a in cfg["agents"]["list"])
    if agents != cfg_agents:
        sys.exit(f"facts: agents/ has {agents} but openclaw.json lists {cfg_agents}")
    defaults = cfg["agents"]["defaults"]
    roles = sorted({u["role"] for u in users})
    grants = perms["grants"]
    matrix = {}
    for role in roles:
        for agent, tools in grants.get(role, {}).items():
            for tool, g in tools.items():
                matrix[(role, tool)] = {"agent": agent, "surfaces": g.get("surfaces", []),
                                        "fields": g.get("fields", []), "maxRecords": g.get("maxRecords")}
    # Only grants on a write tool count. A read-only grant must not make a role a write role.
    write_grants = {k: g for k, g in matrix.items() if k[1] in WRITE_TOOLS}
    write_roles = sorted({role for role, _ in write_grants})
    caps = [g["maxRecords"] for g in write_grants.values() if g["maxRecords"] is not None]
    with open(os.path.join(ROOT, "plugins/user-memory/src/store.ts")) as f:
        m = re.search(r"DEFAULT_MAX_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)", f.read())
    if not m:
        sys.exit("facts: DEFAULT_MAX_BYTES not found in plugins/user-memory/src/store.ts")
    tests = {}
    for p in PLUGINS:
        path = os.path.join(ROOT, ".reports", f"{p}.json")
        if not os.path.exists(path):
            sys.exit("facts: " + report_hint(p))
        with open(path) as f:
            r = json.load(f)
        row = {k: r[k] for k in ("numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests")}
        if row["numFailedTests"] or row["numPendingTests"]:
            sys.exit(f"facts: {p} has {row['numFailedTests']} failed and {row['numPendingTests']} pending tests")
        static = static_test_count(p)
        if static != row["numTotalTests"]:
            sys.exit(f"facts: {p} report counts {row['numTotalTests']} tests but the source declares {static}")
        tests[p] = row["numPassedTests"]
    facts = {
        "agents": agents,
        "n_agents": len(agents),
        "max_sessions": defaults["maxConcurrent"],
        "run_timeout_s": defaults["timeoutSeconds"],
        "provider_timeout_s": cfg["models"]["providers"]["mock"]["timeoutSeconds"],
        "users": [{"name": u["name"], "email": u["email"], "role": u["role"]} for u in users],
        "roles": roles,
        "n_roles": len(roles),
        "matrix": matrix,
        "write_roles": write_roles,
        "n_write_roles": len(write_roles),
        "write_agents": sorted({g["agent"] for g in write_grants.values()}),
        "record_cap": max(caps),
        "memory_cap_kb": int(m.group(1)) * int(m.group(2)) // 1024,
        "tests": tests,
        "tests_total": sum(tests.values()),
    }
    _CACHE["facts"] = facts
    return facts


def main():
    f = load()
    rows = [
        ("agents", f"{f['n_agents']} ({', '.join(f['agents'])})"),
        ("concurrent sessions", f["max_sessions"]),
        ("run timeout, seconds", f["run_timeout_s"]),
        ("model timeout, seconds", f["provider_timeout_s"]),
        ("users and roles", f"{len(f['users'])} users, {f['n_roles']} roles"),
        ("roles with a write grant", f"{f['n_write_roles']} of {f['n_roles']} ({', '.join(f['write_roles'])})"),
        ("bulk record cap", f["record_cap"]),
        ("memory cap per user, KB", f["memory_cap_kb"]),
    ]
    rows += [(f"tests, {p}", n) for p, n in f["tests"].items()]
    rows.append(("tests, total", f["tests_total"]))
    for k, v in rows:
        print(f"{k:<28}{v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
