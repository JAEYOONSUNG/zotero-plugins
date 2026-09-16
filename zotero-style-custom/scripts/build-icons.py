#!/usr/bin/env python3
"""Render the original paper-and-citation mark as SVG and crisp PNG sizes.
The same geometric primitives define both outputs; no external art or app launch.
"""
from pathlib import Path
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'content/icons'
OUT.mkdir(parents=True, exist_ok=True)
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Style Custom: research paper and citation links">
<rect x="2" y="2" width="60" height="60" rx="3" fill="#374151"/>
<path d="M12 19V55H38" fill="none" stroke="#9ca3af" stroke-width="3"/>
<path d="M18 13H38L46 21V51H18Z" fill="#ffffff"/>
<path d="M38 13V21H46Z" fill="#cbd5e1"/>
<path d="M24 27H38M24 32H33" fill="none" stroke="#374151" stroke-width="2"/>
<path d="M27 43L38 38M27 43L38 47" fill="none" stroke="#374151" stroke-width="2"/>
<g fill="#374151"><rect x="24" y="40" width="6" height="6"/><rect x="35" y="35" width="6" height="6"/><rect x="35" y="44" width="6" height="6"/></g>
</svg>
'''
(OUT / 'style-custom.svg').write_text(SVG)
def render(size):
    scale = 8
    ratio = size * scale / 64
    im = Image.new('RGBA', (size*scale, size*scale), (0,0,0,0))
    draw = ImageDraw.Draw(im)
    def coords(values): return [v*ratio for v in values]
    def line(points,color,width): draw.line([(x*ratio,y*ratio) for x,y in points], fill=color,width=max(1,round(width*ratio)))
    draw.rounded_rectangle(coords((2,2,62,62)),radius=3*ratio,fill='#374151')
    line([(12,19),(12,55),(38,55)],'#9ca3af',3)
    draw.polygon([(x*ratio,y*ratio) for x,y in [(18,13),(38,13),(46,21),(46,51),(18,51)]],fill='#ffffff')
    draw.polygon([(x*ratio,y*ratio) for x,y in [(38,13),(38,21),(46,21)]],fill='#cbd5e1')
    for points in [[(24,27),(38,27)],[(24,32),(33,32)],[(27,43),(38,38)],[(27,43),(38,47)]]:line(points,'#374151',2)
    for rect in [(24,40,30,46),(35,35,41,41),(35,44,41,50)]:draw.rectangle(coords(rect),fill='#374151')
    return im.resize((size,size),Image.Resampling.LANCZOS)
for size in [16,24,32,48,96,128,256]:render(size).save(OUT / f'style-custom-{size}.png',optimize=True)
print('Icon assets rendered: original SVG + 7 PNG sizes')
