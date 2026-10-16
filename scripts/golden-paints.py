#!/usr/bin/env python3
"""
Writes src/shared/paints.ts from Golden's spectral data (SPEC 9.3.1).

Usage: python3 scripts/golden-paints.py "Reflectance Data for Golden HB 10 mil Drawdowns over White.xlsx"

The spreadsheet is in GoldenSpectra.zip from https://www.realtimerendering.com/golden.html.
Standard library only. The CIE 1931 2° observer under D65 comes from the same table as the
pigment mixing (src/client/engine/gl/spectral.ts, 380 to 750 nm); the measurement covers 400 to
700 nm, so the ends hold the 400 and 700 nm values.
"""
import math, os, re, sys, zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def sheet_rows(path):
    """The rows of the first sheet of an .xlsx file, as lists of values."""
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    rows = []
    for r in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter('{%s}row' % NS['m']):
        row = {}
        for c in r.findall('m:c', NS):
            v = c.find('m:v', NS)
            if v is None:
                continue
            col = 0
            for ch in re.match(r'[A-Z]+', c.get('r')).group(0):
                col = col * 26 + ord(ch) - 64
            val = shared[int(v.text)] if c.get('t') == 's' else float(v.text)
            row[col - 1] = val
        rows.append([row.get(k) for k in range(max(row) + 1)] if row else [])
    return rows

# CIE 1931 2° x D65, 38 rows (380..750 nm), from the shader
CMF = [[float(x) for x in m] for m in re.findall(r'xyz \+= R\[\s*\d+\] \* vec3\(([\d.]+), ([\d.]+), ([\d.]+)\);', open(os.path.join(ROOT, 'src/client/engine/gl/spectral.ts')).read())]
assert len(CMF) == 38
XYZ_RGB = [[3.2409699419045200, -1.537383177570090, -0.4986107602930030], [-0.9692436362808790, 1.875967501507720, 0.0415550574071756], [0.0556300796969936, -0.203976958888976, 1.0569715142428700]]

def compand(x):
    x = max(0.0, x)
    return x * 12.92 if x < 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

def srgb(R31):
    R = [R31[0]] * 2 + R31 + [R31[-1]] * 5
    xyz = [sum(R[i] * CMF[i][j] for i in range(38)) for j in range(3)]
    return [min(1.0, compand(sum(XYZ_RGB[i][j] * xyz[j] for j in range(3)))) for i in range(3)]

def tohex(c):
    return '#' + ''.join('%02x' % round(v * 255) for v in c)

def oklab(c):
    lin = [v / 12.92 if v < 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    l, m, s = (sum(a * b for a, b in zip(row, lin)) for row in ((0.4122214708, 0.5363325363, 0.0514459929), (0.2119034982, 0.6806995451, 0.1073969566), (0.0883024619, 0.2817188376, 0.6299787005)))
    l, m, s = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)

# Saunderson: take the surface reflection out of the measurement (specular included); what is seen
# without glare is the measurement minus k1.
K1, K2 = 0.04, 0.6
def masstone(Rm):
    out = []
    for r in Rm:
        ri = max(1e-4, (r - K1) / (1 - K1 - K2 + K2 * r))
        out.append((1 - K1) * (1 - K2) * ri / (1 - K2 * ri))
    return out

FIX = {'Cad ': 'Cadmium ', 'cad yellow Primrose': 'Cadmium Yellow Primrose', 'Napthol red Light': 'Naphthol Red Light',
       'Napthol Red Medium': 'Naphthol Red Medium', 'Mars yellow': 'Mars Yellow', 'Hookers': "Hooker's", 'Paynes': "Payne's",
       'Quin ': 'Quinacridone ', 'Perm ': 'Permanent '}

def fix(name):
    for a, b in FIX.items():
        name = name.replace(a, b)
    return name

LIMITED = [
    ('Zorn', 'Yellow ochre, a cadmium red, a black and white: the four colors of Anders Zorn.', ['Yellow Ochre', 'Cadmium Red Light', 'Bone Black', None]),
    ('Split primary', 'A warm and a cool of each primary.', ['Hansa Yellow Light', 'Hansa Yellow Medium', 'Pyrrole Red Light', 'Quinacridone Magenta', 'Ultramarine Blue', 'Phthalo Blue GS']),
    ('Earth', 'Iron oxides and umbers, with a black.', ['Yellow Ochre', 'Raw Sienna', 'Burnt Sienna', 'Red Oxide', 'Raw Umber', 'Burnt Umber', 'Bone Black']),
]

def main(path):
    paints = []
    for r in sheet_rows(path)[2:]:
        if not r or not isinstance(r[0], float):
            continue
        hx = tohex(srgb(masstone([v / 100 for v in r[6:37]])))
        L, a, b = oklab([int(hx[i:i + 2], 16) / 255 for i in (1, 3, 5)])
        C, h = math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360
        group = 2 if C < 0.03 else 1 if (C < 0.12 and 30 <= h <= 110 and L < 0.75) else 0
        key = (group, -L) if group == 2 else (group, (110 - h) % 360)
        paints.append((key, fix(r[1].strip()), hx))
    paints.sort()
    names = {p[1] for p in paints}
    out = ['''// Built-in palettes from measured paint. Golden Artist Colors gave Andrew Glassner and Eric Haines
// the spectral reflectance of 78 Golden Heavy Body acrylics (drawdowns over a white card, 400 to
// 700 nm, https://www.realtimerendering.com/golden.html), with permission to share them. The
// colors here are those spectra seen under D65 by the CIE 1931 observer, converted to sRGB, with
// the gloss of the surface taken out (Saunderson, k1 = 0.04, k2 = 0.6): the color of the paint
// straight from the tube, without glare. Generated by scripts/golden-paints.py; do not edit by hand.

import type { PaletteColor } from './types';

export interface BuiltinPalette {
  id: string;
  name: string;
  note: string;
  colors: PaletteColor[];
}

/** White for the limited palettes: not in the measured set. */
const WHITE: PaletteColor = { hex: '#f4f2ec', name: 'White' };
''', 'export const GOLDEN_HEAVY_BODY: PaletteColor[] = [']
    out += [f'  {{ hex: \'{hx}\', name: "{n}" }},' for _, n, hx in paints]
    out += ['];\n', 'const golden = (name: string): PaletteColor => GOLDEN_HEAVY_BODY.find((c) => c.name === name)!;\n', 'export const BUILTIN_PALETTES: BuiltinPalette[] = [',
            "  { id: 'golden-hb', name: 'Golden Heavy Body acrylics', note: 'Measured: 78 paints straight from the tube, without glare.', colors: GOLDEN_HEAVY_BODY },"]
    for title, note, picks in LIMITED:
        assert all(n is None or n in names for n in picks), picks
        cols = ', '.join('WHITE' if n is None else f'golden("{n}")' for n in picks)
        out.append(f"  {{ id: 'limited-{title.lower().replace(' ', '-')}', name: '{title}', note: \"{note} Golden paints.\", colors: [{cols}] }},")
    out.append('];\n')
    with open(os.path.join(ROOT, 'src/shared/paints.ts'), 'w') as f:
        f.write('\n'.join(out))
    print(f'{len(paints)} paints -> src/shared/paints.ts')

if __name__ == '__main__':
    main(sys.argv[1])
