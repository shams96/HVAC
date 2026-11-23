"""Generate the Vertex AirWorks logo files with the wordmark converted to outlines (no font needed to display).
Run: python scripts/build-brand.py   Output: public/brand/*.svg
Colours mirror src/styles/tokens.css (primary, accent, ink, surface)."""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2")
OUT = os.path.join(ROOT, "public/brand")
TEAL, BERRY, INK, IVORY = "#186767", "#a31d4b", "#0b2a2a", "#f6eedd"

font = instancer.instantiateVariableFont(TTFont(FONT), {"wght": 600})
gs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm

def text_path(s, x, baseline, size, tracking=0.0):
    scale = size / upm
    pen = SVGPathPen(gs)
    cx = x
    for ch in s:
        name = cmap[ord(ch)]
        tp = TransformPen(pen, (scale, 0, 0, -scale, cx, baseline))
        gs[name].draw(tp)
        cx += gs[name].width * scale + tracking
    return pen.getCommands(), cx - tracking

def mark(bg, v, dot, size=64, vw=8):
    # A roof-peak apex (the vertex, also an "A" for AirWorks) over a line of moving air. Two tone: no accent colour inside the mark.
    lw = max(vw - 2, 5)
    return (f'<rect width="64" height="64" rx="14" fill="{bg}"/>'
            f'<path d="M14 35 L32 14 L50 35" fill="none" stroke="{v}" stroke-width="{vw}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="M14 49 C19 42 25 42 32 49 C39 56 45 56 50 49" fill="none" stroke="{v}" stroke-width="{lw}" stroke-linecap="round"/>')

def lockup(bg, v, dot, c1, c2):
    d1, w1 = text_path("Vertex", 80, 27, 28, 0.2)
    d2, w2 = text_path("AirWorks", 80, 57, 28, 0.2)
    w = max(w1, w2) + 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} 64" width="{w:.0f}" height="64" role="img" aria-labelledby="t">'
            f'<title id="t">Vertex AirWorks</title>{mark(bg, v, dot)}'
            f'<path d="{d1}" fill="{c1}"/><path d="{d2}" fill="{c2}"/></svg>')

def write(name, s):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f: f.write(s)

write("logo.svg", lockup(TEAL, IVORY, BERRY, INK, TEAL))
write("logo-on-dark.svg", lockup(IVORY, TEAL, BERRY, IVORY, IVORY))
write("mark.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Vertex AirWorks">{mark(TEAL, IVORY, BERRY)}</svg>')
# Favicon: same mark, heavier V so it holds at 16 px.
write("../favicon.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{mark(TEAL, IVORY, BERRY, vw=9)}</svg>')
print("ok")
