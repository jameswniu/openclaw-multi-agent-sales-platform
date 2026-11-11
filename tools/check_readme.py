#!/usr/bin/env python3
"""Fail when README.md disagrees with the repo, or breaks a landing limit. One line per check, then OK.

    python3 tools/check_readme.py            run every check
    python3 tools/check_readme.py --names    run only the old-name and path scan
    python3 tools/check_readme.py --dashes   run only the dash scan of tracked .md files

Checks: badge values against tools/facts.py (a required badge that is missing fails), numbers in the
prose against the same facts, that each required figure is embedded and its generator reports no
drift, word, paragraph and sentence limits, and a scan of every non-lock file for leftover markers
of the old project. Exit 0 is clean, 1 is drift, 2 is a broken or missing input.
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts  # noqa: E402
import palette as P  # noqa: E402

ROOT = P.ROOT
README = os.path.join(ROOT, "README.md")
REQUIRED_BADGES = ("agents", "sessions", "tests", "grants", "memory")
REQUIRED_FIGURES = ("assets/hero.svg", "assets/map.svg", "assets/permissions.svg")
BADGE_RE = re.compile(r"https://img\.shields\.io/badge/([A-Za-z_]+)-([^-\s)\"]+)-[A-Za-z0-9]+")
# Marker words are written in pieces so this file does not contain them itself.
MARKERS = ["chal" + "lenge", "gtm-ai-" + "engineer", "inter" + "view", "co" + "dex", "commit " + "gate", "take-" + "home",
           "<fo" + "nt", "customer" + r"\.?io", "/Us" + "ers/"]
MARKER_RE = re.compile("|".join(MARKERS), re.I)
DASH_RE = re.compile("[" + chr(8211) + chr(8212) + "]")
LIMITS = {"words": 900, "paragraph": 70, "sentence": 35}


def files(exts=None):
    """Tracked and not-yet-tracked files that git does not ignore, relative to the repo root."""
    r = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, capture_output=True)
    if r.returncode:
        print("check_readme: git ls-files failed", file=sys.stderr)
        sys.exit(2)
    names = [n for n in r.stdout.decode().split("\0") if n and os.path.exists(os.path.join(ROOT, n))]
    return [n for n in names if exts is None or n.endswith(exts)]


def scan(names, pattern, label):
    bad = 0
    for n in names:
        with open(os.path.join(ROOT, n), encoding="utf-8", errors="replace") as f:
            for i, ln in enumerate(f, 1):
                if pattern.search(ln):
                    print(f"DRIFT [{label}] {n}:{i}: {ln.strip()[:90]}")
                    bad += 1
    if not bad:
        print(f"ok [{label}]")
    return bad


def check_names():
    names = [n for n in files() if os.path.basename(n) != "package-lock.json" and not n.endswith((".gif", ".png"))]
    return scan(names, MARKER_RE, "old names and paths")


def check_dashes():
    return scan(files(".md"), DASH_RE, "dash glyphs in tracked .md")


def decode(v):
    return v.replace("_", " ").replace("%2F", "/")


def check_badges(text, f):
    want = {"agents": str(f["n_agents"]), "sessions": str(f["max_sessions"]), "tests": str(f["tests_total"]),
            "grants": f"{f['n_write_roles']} of {f['n_roles']}", "memory": f"{f['memory_cap_kb']} KB"}
    found = {}
    bad = 0
    for label, value in BADGE_RE.findall(text):
        if label in found:
            print(f"DRIFT [badge {label}] appears more than once")
            bad += 1
        found[label] = decode(value)
    for label in REQUIRED_BADGES:
        if label not in found:
            print(f"DRIFT [badge {label}] missing from the README")
            bad += 1
        elif found[label] != want[label]:
            print(f"DRIFT [badge {label}] README says {found[label]}, facts say {want[label]}")
            bad += 1
        else:
            print(f"ok [badge {label}] {found[label]}")
    return bad


def check_claims(text, f):
    sf = f["tests"]
    claims = [
        (r"(\d+) agents", f["n_agents"]),
        (r"(\d+) concurrent sessions", f["max_sessions"]),
        (r"(\d+)[- ]second run timeout", f["run_timeout_s"]),
        (r"(\d+)[- ]second model timeout", f["provider_timeout_s"]),
        (r"(\d+) KB", f["memory_cap_kb"]),
        (r"(\d+) plugin tests", f["tests_total"]),
        (r"(\d+)[- ]record", f["record_cap"]),
        (r"(\d+) of \d+ roles", f["n_write_roles"]),
        (r"\d+ of (\d+) roles", f["n_roles"]),
        (r"(\d+) in Salesforce", sf["salesforce"]),
        (r"(\d+) in PartnerStack", sf["partnerstack"]),
        (r"(\d+) in user-memory", sf["user-memory"]),
        (r"(\d+) users", len(f["users"])),
    ]
    bad = 0
    for pat, want in claims:
        got = re.findall(pat, text)
        if not got:
            print(f"DRIFT [claim {pat}] never appears in the README")
            bad += 1
        elif any(int(g) != want for g in got):
            print(f"DRIFT [claim {pat}] README says {sorted(set(got))}, facts say {want}")
            bad += 1
        else:
            print(f"ok [claim {pat}] {want}")
    return bad


def check_figures(text):
    bad = 0
    for fig in REQUIRED_FIGURES:
        if fig not in text:
            print(f"DRIFT [figure {fig}] not embedded in the README")
            bad += 1
        elif not os.path.exists(os.path.join(ROOT, fig)):
            print(f"DRIFT [figure {fig}] embedded but the file is missing")
            bad += 1
    for m in re.findall(r'(?:src|href)="(assets/[^"]+)"', text):
        if not os.path.exists(os.path.join(ROOT, m)):
            print(f"DRIFT [figure {m}] referenced but the file is missing")
            bad += 1
    for g in ("render_hero.py", "render_map.py", "render_panel.py"):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", g), "--check"], capture_output=True, text=True)
        if r.returncode:
            print(f"DRIFT [generator {g}] exited {r.returncode}\n{r.stdout[-800:]}")
            bad += 1
        else:
            print(f"ok [generator {g}]")
    return bad


def prose_blocks(text):
    """Yield (kind, text) for visible prose. Fences, HTML, code spans and table rules do not count."""
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"`[^`]*`", "", text)
    for block in re.split(r"\n\s*\n", text):
        lines = [ln for ln in block.splitlines() if ln.strip() and not re.match(r"^\s*\|[-\s|]+\|\s*$", ln)]
        if not lines:
            continue
        head = lines[0].lstrip()
        kind = "list" if head.startswith(("- ", "|", "> ", "#")) else "para"
        yield kind, " ".join(l.strip() for l in lines) if kind == "para" else "\n".join(lines)


def sentences(s):
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    return [x for x in re.split(r"(?<=[.!?])\s+", s) if x.strip()]


def words(s):
    return len(re.findall(r"[A-Za-z0-9][\w'.-]*", re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)))


def check_limits(text):
    bad = 0
    total = longest_p = longest_s = 0
    for kind, block in prose_blocks(text):
        total += words(block)
        if kind == "para":
            longest_p = max(longest_p, words(block))
        for ln in block.splitlines():
            for s in sentences(ln):
                longest_s = max(longest_s, words(s))
    print(f"words {total}, longest paragraph {longest_p} words, longest sentence {longest_s} words")
    for name, val in (("words", total), ("paragraph", longest_p), ("sentence", longest_s)):
        if (val >= LIMITS[name]) if name == "words" else (val > LIMITS[name]):
            print(f"DRIFT [limit {name}] {val} breaks the limit of {LIMITS[name]}")
            bad += 1
    badges = len(BADGE_RE.findall(text)) + text.count("badge.svg")
    imgs = len(re.findall(r"<img ", text))
    gifs = len(re.findall(r'src="[^"]+\.gif"', text))
    first = [ln for ln in text.splitlines() if ln.strip()][:15]
    for name, ok in (("4 badges", badges >= 4), ("3 images", imgs >= 3), ("1 gif", gifs >= 1),
                     ("picture in first 15 lines", any("<img" in ln for ln in first))):
        if not ok:
            print(f"DRIFT [limit {name}] not met")
            bad += 1
    if not DASH_RE.search(text) and not re.search("[" + chr(8592) + chr(8594) + "]", text):
        print("ok [no dash or arrow glyphs in README]")
    else:
        print("DRIFT [glyphs] README has a dash or arrow glyph")
        bad += 1
    return bad


def main(argv):
    if argv == ["--names"]:
        return 1 if check_names() else 0
    if argv == ["--dashes"]:
        return 1 if check_dashes() else 0
    try:
        with open(README, encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        print("check_readme: README.md is missing", file=sys.stderr)
        return 2
    f = facts.load()
    bad = check_badges(text, f) + check_claims(text, f) + check_figures(text) + check_limits(text) + check_names() + check_dashes()
    if bad:
        print(f"\n{bad} check(s) failed. Fix the README or regenerate the figures, then re-run.")
        return 1
    print("OK: README, badges and figures agree with the repo")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
