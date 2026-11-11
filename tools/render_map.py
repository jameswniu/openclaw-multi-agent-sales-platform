#!/usr/bin/env python3
"""Emit assets/map.svg, the request path with the four additions numbered. Numbers come from tools/facts.py.

    python3 tools/render_map.py --write | --check

The path is: a request reaches the gateway (the OpenClaw server that runs the agents), then an agent,
then the permission guard (plugins/policy-core, which checks a write against config/permissions.json),
then an integration (the Salesforce mock or the PartnerStack plugin).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts  # noqa: E402
import palette as P  # noqa: E402

OUT = os.path.join(P.ROOT, "assets", "map.svg")
W, H = 1200, 620
M = 40
BW, GAP = 196, 35


def build():
    f = facts.load()
    label = (f"Request path: a request reaches the gateway, then one of {f['n_agents']} agents, then the permission guard, then an integration. "
             f"Four additions are numbered on the boxes they touch. The model and both backends are mocks.")
    out = [P.svg_open(W, H, label)]
    out.append(P.t(M, 56, "REQUEST PATH", 23, P.MUTED, spacing=2, inner=400))
    boxes = [
        ("Request", ["from a user"], None),
        ("Gateway", [f"{f['max_sessions']} sessions"], "1"),
        ("Agent", [f"{f['n_agents']} agents", "own memory"], "2"),
        ("Permission", ["guard"], "3"),
        ("Integration", ["Salesforce", "PartnerStack"], "4"),
    ]
    top, bh = 140, 150
    for i, (title, subs, num) in enumerate(boxes):
        x = M + i * (BW + GAP)
        out.append(P.rect(x, top, BW, bh, P.PANEL, P.ACCENT if num else P.EDGE, sw=3 if num else 2))
        out.append(P.t(x + 16, top + 50, title, 23, P.INK, bold=True, inner=BW - 32))
        for j, s in enumerate(subs):
            out.append(P.t(x + 16, top + 88 + j * 30, s, 23, P.MUTED, inner=BW - 32))
        if num:
            out.append(P.rect(x, top - 52, 36, 36, P.PANEL, P.ACCENT, sw=3))
            out.append(P.t(x + 18, top - 25, num, 24, P.ACCENT, bold=True, anchor="middle"))
        if i < len(boxes) - 1:
            ax = x + BW
            out.append(P.line(ax + 4, top + bh // 2, ax + GAP - 4, top + bh // 2, P.MUTED))
            out.append(P.line(ax + GAP - 14, top + bh // 2 - 8, ax + GAP - 4, top + bh // 2, P.MUTED))
            out.append(P.line(ax + GAP - 14, top + bh // 2 + 8, ax + GAP - 4, top + bh // 2, P.MUTED))
    legend = [
        ("1", f"Session cap, {f['max_sessions']} concurrent, {f['run_timeout_s']} s run and {f['provider_timeout_s']} s model timeout"),
        ("2", f"Per-user memory, {f['memory_cap_kb']} KB cap per user"),
        ("3", f"Per-user write guard, {f['n_write_roles']} of {f['n_roles']} roles can write, {f['record_cap']}-record cap"),
        ("4", "PartnerStack plugin, built and tested, not switched on"),
    ]
    y = 346
    for num, text in legend:
        out.append(P.rect(M, y - 26, 36, 36, P.PANEL, P.ACCENT, sw=3))
        out.append(P.t(M + 18, y + 1, num, 24, P.ACCENT, bold=True, anchor="middle"))
        out.append(P.t(M + 56, y + 1, text, 24, P.INK, inner=W - 2 * M - 56))
        y += 54
    out.append(P.line(M, 548, W - M, 548))
    out.append(P.t(M, 588, "The model server, Salesforce and PartnerStack backends are mocks.", 23, P.MUTED, inner=W - 2 * M))
    out.append("</svg>\n")
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(P.run(sys.argv[1:], OUT, build))
