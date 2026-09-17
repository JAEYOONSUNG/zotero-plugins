#!/usr/bin/env python3
"""Render the plugin mark as the SVG that ships plus the PNG sizes Zotero asks for.

The mark is the item tree itself: a gutter of row markers, ragged rows, and one
row picked out in the same gold the rating stars use. Rows of equal length would
read as a hamburger menu, which is why they are ragged.

rsvg-convert rasterises the very SVG that ships, so the PNGs cannot drift from
the vector the way a hand-drawn raster copy does.
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'content/icons'
OUT.mkdir(parents=True, exist_ok=True)

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Style Custom: a library row marked">
  <rect width="128" height="128" rx="28" fill="#2B3240"/>
  <g fill="#FFFFFF" opacity="0.5">
    <circle cx="31" cy="41" r="6"/><circle cx="31" cy="64" r="6"/><circle cx="31" cy="87" r="6"/>
  </g>
  <g fill="#FFFFFF">
    <rect x="46" y="34" width="56" height="14" rx="7"/>
    <rect x="46" y="80" width="40" height="14" rx="7"/>
  </g>
  <rect x="46" y="57" width="50" height="14" rx="7" fill="#E9A81C"/>
</svg>
'''
(OUT / 'style-custom.svg').write_text(SVG, encoding='utf-8')

SIZES = [16, 24, 32, 48, 96, 128, 256]
for size in SIZES:
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                    '-o', str(OUT / f'style-custom-{size}.png'), str(OUT / 'style-custom.svg')],
                   check=True)
print(f'Icon assets rendered: SVG + {len(SIZES)} PNG sizes')
