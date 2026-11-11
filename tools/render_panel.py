#!/usr/bin/env python3
"""Emit assets/permissions.svg, the table of roles against the two Salesforce write tools. Data comes from tools/facts.py.

    python3 tools/render_panel.py --write | --check

A cell lists the fields a role may change, outlined in teal. A role with no grant gets a muted dashed
outline. The last row shows that no PartnerStack grant ships in config/permissions.json.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts  # noqa: E402
import palette as P  # noqa: E402

OUT = os.path.join(P.ROOT, "assets", "permissions.svg")
W = 1200
M = 40
COLS = [(M, 300), (M + 300 + 12, 370), (M + 300 + 12 + 370 + 12, 418)]
TOOLS = [("update_account", facts.WRITE_TOOLS[0]), ("bulk_update_accounts", facts.WRITE_TOOLS[1])]
RH, GAP = 76, 10


def cell_text(g, bulk):
    text = ", ".join(g["fields"])
    return f"{text}, up to {g['maxRecords']} records" if bulk and g["maxRecords"] is not None else text


def build():
    f = facts.load()
    names = {}
    for u in f["users"]:
        names.setdefault(u["role"], u["name"])
    agent = f["write_agents"][0]
    label = (f"Permission matrix for the {agent} agent. {f['n_write_roles']} of {f['n_roles']} roles hold a write grant on the two Salesforce write tools. "
             f"No PartnerStack grant ships.")
    top = 140
    H = top + RH + GAP + (f["n_roles"] + 1) * (RH + GAP) + 76
    out = [P.svg_open(W, H, label)]
    out.append(P.t(M, 56, "WHO CAN WRITE", 23, P.MUTED, spacing=2, inner=400))
    out.append(P.t(M, 100, f"Salesforce write tools, {agent} agent only", 26, P.INK, bold=True, inner=W - 2 * M))
    y = top
    out.append(P.t(COLS[0][0] + 16, y + 46, "Role", 24, P.MUTED, bold=True, inner=COLS[0][1] - 32))
    for (title, _), (cx, cw) in zip(TOOLS, COLS[1:]):
        out.append(P.t(cx + 16, y + 46, title, 23, P.MUTED, mono=True, inner=cw - 32))
    out.append(P.line(M, y + RH - 8, W - M, y + RH - 8))
    y += RH + GAP
    for role in f["roles"]:
        out.append(P.t(COLS[0][0] + 16, y + 34, role, 24, P.INK, bold=True, inner=COLS[0][1] - 32))
        out.append(P.t(COLS[0][0] + 16, y + 62, names.get(role, ""), 23, P.MUTED, inner=COLS[0][1] - 32))
        for i, ((_, tool), (cx, cw)) in enumerate(zip(TOOLS, COLS[1:])):
            g = f["matrix"].get((role, tool))
            if g:
                out.append(P.rect(cx, y, cw, RH, P.PANEL, P.TEAL, sw=2))
                out.append(P.t(cx + 16, y + 46, cell_text(g, i == 1), 24, P.INK, inner=cw - 32))
            else:
                out.append(P.rect(cx, y, cw, RH, "none", P.MUTED, sw=2, dash="8 6"))
                out.append(P.t(cx + 16, y + 46, "no grant", 24, P.MUTED, inner=cw - 32))
        y += RH + GAP
    out.append(P.t(COLS[0][0] + 16, y + 34, "PartnerStack", 24, P.INK, bold=True, inner=COLS[0][1] - 32))
    out.append(P.t(COLS[0][0] + 16, y + 62, "all roles", 23, P.MUTED, inner=COLS[0][1] - 32))
    out.append(P.rect(COLS[1][0], y, COLS[2][0] + COLS[2][1] - COLS[1][0], RH, "none", P.MUTED, sw=2, dash="8 6"))
    out.append(P.t(COLS[1][0] + 16, y + 46, "No grant shipped, plugin not switched on", 24, P.MUTED, inner=600))
    y += RH + GAP
    out.append(P.t(M, y + 40, "From config/permissions.json. Teal outline: allowed. Dashed: no grant.", 23, P.MUTED, inner=W - 2 * M))
    out.append("</svg>\n")
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(P.run(sys.argv[1:], OUT, build))
