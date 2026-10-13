import sys, math
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1]  # python3 tools/vvs-standin-icons/draw.py <out-dir>; then base64 each PNG into ui/automation/virindiIcons.ts
K = 16  # supersample: draw at 256, downsample to 16
N = 16 * K
def S(v): return int(round(v * K))
def canvas(): return Image.new('RGBA', (N, N), (16, 14, 10, 255))
def radial(d, cx, cy, r, inner, outer, hx=None, hy=None):
    hx = cx if hx is None else hx; hy = cy if hy is None else hy
    for i in range(S(r), 0, -1):
        t = i / S(r)
        c = tuple(int(inner[k] * (1 - t) + outer[k] * t) for k in range(3)) + (255,)
        ox = (hx - cx) * (1 - t); oy = (hy - cy) * (1 - t)
        d.ellipse([S(cx + ox) - i, S(cy + oy) - i, S(cx + ox) + i, S(cy + oy) + i], fill=c)
def done(im, name):
    im.resize((16, 16), Image.LANCZOS).save(f'{out}/{name}.png')

# VTank: grey disc, olive tank, red V
im = canvas(); d = ImageDraw.Draw(im)
d.ellipse([S(0.5), S(0.5), S(15.5), S(15.5)], fill=(40, 40, 40, 255))
radial(d, 8, 8, 7, (235, 235, 235), (120, 120, 120), 6, 6)
olive, dark = (122, 120, 40, 255), (60, 58, 16, 255)
d.polygon([(S(2.5), S(10)), (S(13.5), S(10)), (S(12), S(13.2)), (S(4), S(13.2))], fill=olive, outline=dark, width=K)   # tracks
for x in (4.6, 6.6, 8.6, 10.6): d.ellipse([S(x), S(11), S(x + 1.2), S(12.2)], fill=dark)
d.rectangle([S(4), S(8), S(12), S(10)], fill=olive, outline=dark, width=K)    # hull
d.rounded_rectangle([S(5.5), S(6.2), S(10), S(8.4)], radius=S(1), fill=olive, outline=dark, width=K)  # turret
d.rectangle([S(10), S(6.8), S(14), S(7.8)], fill=dark)                         # barrel
red = (200, 20, 20, 255)
d.line([(S(6), S(1.6)), (S(8), S(5.4)), (S(10), S(1.6))], fill=red, width=S(1.5), joint='curve')
done(im, 'vtank')

# VHS: light key cap, green curved arrow
im = canvas(); d = ImageDraw.Draw(im)
d.rounded_rectangle([S(1), S(1), S(15), S(15)], radius=S(2.5), fill=(150, 150, 150, 255))
d.rounded_rectangle([S(1.6), S(1.4), S(14.4), S(13.8)], radius=S(2), fill=(238, 240, 236, 255))
g, gd = (70, 170, 40, 255), (30, 100, 20, 255)
d.arc([S(3.5), S(3.5), S(12), S(13)], start=180, end=345, fill=gd, width=S(2.8))
d.arc([S(3.8), S(3.8), S(11.7), S(12.7)], start=182, end=343, fill=g, width=S(2.2))
d.polygon([(S(9.6), S(5.2)), (S(14.6), S(7.6)), (S(10.2), S(10.6))], fill=g, outline=gd, width=K)
done(im, 'vhs')

# Virindi UIs: parchment scroll
im = canvas(); d = ImageDraw.Draw(im)
paper, ink, wood, woodd = (226, 196, 138, 255), (80, 52, 24, 255), (120, 78, 36, 255), (70, 42, 16, 255)
d.rectangle([S(3), S(2.5), S(13), S(13.5)], fill=paper, outline=woodd, width=K)
for y in (5, 7, 9, 11): d.line([(S(4.6), S(y)), (S(11.4 if y != 11 else 8.5), S(y))], fill=ink, width=S(1.1))
for y0 in (1, 13):
    d.rounded_rectangle([S(1.5), S(y0), S(14.5), S(y0 + 2)], radius=S(1), fill=wood, outline=woodd, width=K)
done(im, 'vuis')

# VCS: crystal snow globe on a small base
im = canvas(); d = ImageDraw.Draw(im)
d.polygon([(S(4), S(15.3)), (S(12), S(15.3)), (S(10.8), S(12.5)), (S(5.2), S(12.5))], fill=(90, 70, 50, 255))
d.ellipse([S(1.5), S(0.5), S(14.5), S(13.5)], fill=(50, 60, 80, 255))
radial(d, 8, 7, 6.2, (250, 252, 255), (110, 125, 160), 7, 5.5)
import random; random.seed(7)
for _ in range(14):
    a = random.random() * 2 * math.pi; r = 1.5 + random.random() * 4
    x, y = 8 + r * math.cos(a), 7 + r * math.sin(a)
    d.ellipse([S(x - .35), S(y - .35), S(x + .35), S(y + .35)], fill=(255, 255, 255, 230))
done(im, 'vcs')
