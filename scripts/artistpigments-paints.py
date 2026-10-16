#!/usr/bin/env python3
"""
Writes src/client/paint-library.json from the palette-builder data files (SPEC 9.3.1).

Usage: python3 scripts/artistpigments-paints.py <dir with paints.json gouache.json oil.json acrylic.json>

The files are data/*.json of https://github.com/colleen-love/palette-builder (Apache-2.0 code).
The colors and properties in them come from artistpigments.org, licensed CC BY-NC 4.0: credit
artistpigments.org, and no commercial use. Their CIELAB values are masstones measured with a
45°/0° spectrophotometer (no gloss), D50 and the 2° observer; Bradford adapts them to D65 for sRGB.
Out-of-gamut colors clip. Standard library only.
"""
import json, math, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MEDIA = [('watercolor', 'Watercolor', 'paints.json'), ('gouache', 'Gouache', 'gouache.json'), ('oil', 'Oil', 'oil.json'), ('acrylic', 'Acrylic', 'acrylic.json')]

D50 = (0.96422, 1.0, 0.82521)
BRADFORD_D50_D65 = ((0.9555766, -0.0230393, 0.0631636), (-0.0282895, 1.0099416, 0.0210077), (0.0122982, -0.0204830, 1.3299098))
XYZ_RGB = ((3.2409699419045200, -1.537383177570090, -0.4986107602930030), (-0.9692436362808790, 1.875967501507720, 0.0415550574071756), (0.0556300796969936, -0.203976958888976, 1.0569715142428700))

def mul(m, v):
    return [sum(m[i][j] * v[j] for j in range(3)) for i in range(3)]

def lab_d50_to_hex(L, a, b):
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    finv = lambda t: t ** 3 if t ** 3 > 216 / 24389 else (116 * t - 16) / (24389 / 27)
    xyz = [D50[0] * finv(fx), D50[1] * finv(fy), D50[2] * finv(fz)]
    lin = mul(XYZ_RGB, mul(BRADFORD_D50_D65, xyz))
    comp = lambda x: 12.92 * x if x < 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return '#' + ''.join('%02x' % round(min(1.0, max(0.0, comp(max(0.0, x)))) * 255) for x in lin)

def oklab(hx):
    c = [int(hx[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [v / 12.92 if v < 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    l, m, s = (sum(a * b for a, b in zip(row, lin)) for row in ((0.4122214708, 0.5363325363, 0.0514459929), (0.2119034982, 0.6806995451, 0.1073969566), (0.0883024619, 0.2817188376, 0.6299787005)))
    l, m, s = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)

def hue_key(hx):
    """Yellow to red to violet to blue to green, then the earths, then the neutrals (as paints.ts)."""
    L, a, b = oklab(hx)
    C, h = math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360
    group = 2 if C < 0.03 else 1 if (C < 0.12 and 30 <= h <= 110 and L < 0.75) else 0
    return (group, -L) if group == 2 else (group, (110 - h) % 360)

def main(src):
    out = {'source': 'artistpigments.org (https://artistpigments.org), via palette-builder', 'license': 'CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/)', 'media': []}
    total = 0
    for mid, mname, fname in MEDIA:
        data = json.load(open(os.path.join(src, fname)))
        out.setdefault('retrieved', data.get('retrieved'))
        brands = {b['key']: b for b in data['brands']}
        lines = {}
        for p in data['paints']:
            hx = lab_d50_to_hex(p['L'], p['a'], p['b'])
            entry = [p['name'].strip(), hx, ' '.join(p.get('pig') or [])]
            if p.get('disc'):
                entry.append(1)
            lines.setdefault(p['brand'], []).append((hue_key(hx), entry))
        media = {'id': mid, 'name': mname, 'brands': []}
        for key, items in sorted(lines.items(), key=lambda kv: brands[kv[0]]['name'].lower()):
            items.sort(key=lambda x: x[0])
            media['brands'].append({'id': key, 'name': brands[key]['name'], 'short': brands[key].get('short') or brands[key]['name'], 'paints': [e for _, e in items]})
            total += len(items)
        out['media'].append(media)
    dest = os.path.join(ROOT, 'src/client/paint-library.json')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{total} paints in {sum(len(m["brands"]) for m in out["media"])} lines -> src/client/paint-library.json ({os.path.getsize(dest)} bytes)')

if __name__ == '__main__':
    main(sys.argv[1])
