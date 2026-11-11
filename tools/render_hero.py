#!/usr/bin/env python3
"""Emit assets/hero.svg, the three headline cards at the top of the README. Every number comes from tools/facts.py.

    python3 tools/render_hero.py --write    regenerate
    python3 tools/render_hero.py --check    exit 1 with a diff if the file on disk drifted
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts  # noqa: E402
import palette as P  # noqa: E402

OUT = os.path.join(P.ROOT, "assets", "hero.svg")
W, H = 1200, 456
M = 48


def build():
    f = facts.load()
    label = (f"OpenClaw multi-agent sales platform, hardened for a team. {f['max_sessions']} concurrent sessions with a {f['run_timeout_s']} second run "
             f"timeout and a {f['provider_timeout_s']} second model timeout, {f['tests_total']} plugin tests across {len(f['tests'])} plugins, "
             f"and {f['n_write_roles']} of {f['n_roles']} roles holding a write grant with a {f['record_cap']} record bulk cap.")
    out = [P.svg_open(W, H, label)]
    inner = W - 2 * M
    out.append(P.t(M, 56, "OPENCLAW MULTI-AGENT SALES PLATFORM", 23, P.MUTED, spacing=2, inner=inner))
    out.append(P.t(M, 112, "Hardened for a team", 44, P.INK, bold=True, inner=inner))
    out.append(P.t(M, 158, "A stock single-user demo fleet, plus four additions. All data is fictional.", 25, P.MUTED, inner=inner))
    gap = 24
    w = (inner - 2 * gap) // 3
    cards = [
        (str(f["max_sessions"]), ["concurrent sessions", f"{f['run_timeout_s']} s run timeout", f"{f['provider_timeout_s']} s model timeout"]),
        (str(f["tests_total"]), ["plugin tests", f"{len(f['tests'])} plugins", "no key, no network"]),
        (f"{f['n_write_roles']} of {f['n_roles']}", ["roles can write", f"{f['record_cap']}-record bulk cap", "PartnerStack: no grant"]),
    ]
    top, ch = 190, 192
    x = M
    for big, cap in cards:
        out.append(P.rect(x, top, w, ch, P.PANEL, P.EDGE))
        out.append(P.rect(x, top, w, 4, P.ACCENT, None))
        out.append(P.t(x + 22, top + 62, big, 48, P.INK, bold=True, inner=w - 44))
        for i, ln in enumerate(cap):
            out.append(P.t(x + 22, top + 104 + i * 30, ln, 24 if i == 0 else 23, P.INK if i == 0 else P.MUTED, inner=w - 44))
        x += w + gap
    out.append(P.t(M, 436, "node scripts/demo-guard.mjs", 23, P.MUTED, mono=True, inner=inner))
    out.append("</svg>\n")
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(P.run(sys.argv[1:], OUT, build))
