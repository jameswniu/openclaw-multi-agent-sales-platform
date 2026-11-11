"""Shared colors, fonts, SVG helpers and the text-fit guard used by every figure generator in tools/.

The look is graphite: a dark ground, thin strokes, square corners and one hairline frame. Coral marks
this repo's four additions, teal marks an allowed write or a held grant, and a muted dashed outline
marks a missing grant. Nothing is filled with an alert color.
"""
import difflib
import html
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GROUND = "#0e1117"
PANEL = "#171c24"
EDGE = "#2c333d"
INK = "#e6e9ee"
MUTED = "#8b949e"
ACCENT = "#ff5c5c"
TEAL = "#5bbfad"
FONT_SANS = "-apple-system, Segoe UI, Helvetica, Arial, sans-serif"
FONT_MONO = "SF Mono, Menlo, Consolas, monospace"
FLOOR = 23


def fit(text, size, box_inner_width, bold=False, mono=False, spacing=0):
    """Raise ValueError naming the string when its estimated width exceeds the box."""
    if size < FLOOR:
        raise ValueError(f"font {size} below the {FLOOR} floor for {text!r}")
    factor = 0.6 if mono else (0.62 if bold else 0.58)
    est = len(text) * size * factor + max(len(text) - 1, 0) * spacing
    if est > box_inner_width:
        raise ValueError(f"text does not fit: {text!r} needs {est:.0f} of {box_inner_width:.0f}")
    return est


def esc(s):
    return html.escape(s, quote=True)


def t(x, y, s, size, fill=INK, bold=False, mono=False, anchor=None, spacing=None, inner=None):
    """One text element. When `inner` (the box's inner width) is given, the fit guard runs."""
    if inner is not None:
        fit(s, size, inner, bold, mono, spacing or 0)
    a = f' text-anchor="{anchor}"' if anchor else ""
    sp = f' letter-spacing="{spacing}"' if spacing else ""
    w = ' font-weight="700"' if bold else ""
    fam = FONT_MONO if mono else FONT_SANS
    return f'<text x="{x}" y="{y}" font-family="{esc(fam)}" font-size="{size}" fill="{fill}"{w}{a}{sp}>{esc(s)}</text>'


def rect(x, y, w, h, fill="none", stroke=None, sw=2, dash=None):
    """A square-cornered rectangle with a 2 unit stroke by default."""
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="0" fill="{fill}"{s}{d}/>'


def line(x1, y1, x2, y2, stroke=EDGE, sw=2, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{d}/>'


def svg_open(w, h, label):
    """The root element, a graphite ground and a hairline frame inset 1 unit."""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" role="img" '
            f'shape-rendering="crispEdges" aria-label="{esc(label)}">\n'
            f'<rect width="{w}" height="{h}" fill="{GROUND}"/>\n'
            f'<rect x="1" y="1" width="{w - 2}" height="{h - 2}" fill="none" stroke="{EDGE}" stroke-width="2"/>')


def run(argv, out_path, build):
    """Shared --write and --check driver. `build()` returns the file text."""
    mode = argv[0] if argv else ""
    if mode not in ("--write", "--check"):
        print(f"usage: {sys.argv[0]} --write | --check", file=sys.stderr)
        return 64
    new = build()
    rel = os.path.relpath(out_path, ROOT)
    if mode == "--write":
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w") as f:
            f.write(new)
        print(f"wrote {rel}")
        return 0
    try:
        old = open(out_path).read()
    except FileNotFoundError:
        old = ""
    if old == new:
        print(f"ok {rel}")
        return 0
    sys.stdout.writelines(difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"a/{rel}", f"b/{rel}"))
    print(f"\ndrift: {rel} differs from its generator")
    return 1
