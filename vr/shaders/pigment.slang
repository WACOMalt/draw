// Pigment paint mixing, as the 2D app does it (src/client/engine/gl/spectral.ts, and
// pigment_mix and PIGMENT_FS in programs.ts).
//
// Kubelka-Munk spectral paint mixing, from spectral.js by Ronald van Wijnen (MIT License,
// https://github.com/rvanwijnen/spectral.js, shader/spectral.glsl):
//
// MIT License. Copyright (c) 2025 Ronald van Wijnen. Permission is hereby granted, free of
// charge, to any person obtaining a copy of this software and associated documentation files
// (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions: The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
// OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// A color becomes a reflectance curve at 38 wavelengths (380 to 750 nm), from 7 base curves
// (white, cyan, magenta, yellow, red, green, blue). Paints mix by their absorption over
// scattering (K/S), weighted by amount and luminance, and the mix goes back to sRGB through the
// CIE observer. Thus blue and yellow make green, as paint does, not grey.
module pigment;

static const float SPECTRAL_EPSILON = 1e-16;

// The 7 base reflectance curves (white, cyan, magenta, yellow, red, green, blue) at 38
// wavelengths, 380 to 750 nm.
static const float BASE_W[38] = { 1.0011607271876400, 1.0011606515972800, 1.0011603192274700, 1.0011586727078900, 1.0011525984455200, 1.0011325252899800, 1.0010850066332700, 1.0009968788945300, 1.0008652515227400, 1.0006962900094000, 1.0005049611488800, 1.0003080818799200, 1.0001196660201300, 0.9999527659684070, 0.9998218368992970, 0.9997386095575930, 0.9997095516396120, 0.9997319302106270, 0.9997994363461950, 0.9999003303166710, 1.0000204065261100, 1.0001447879365800, 1.0002599790341200, 1.0003557969708900, 1.0004275378026900, 1.0004762334488800, 1.0005072096750800, 1.0005251915637300, 1.0005350960689600, 1.0005402209748200, 1.0005427281678400, 1.0005438956908700, 1.0005444821215100, 1.0005447695999200, 1.0005448988776200, 1.0005449625468900, 1.0005449892705800, 1.0005449969930000 };
static const float BASE_C[38] = { 0.9705850013229620, 0.9705924981434250, 0.9706253487298910, 0.9707868061190170, 0.9713686732282480, 0.9731632306212520, 0.9767402231587650, 0.9815876054913770, 0.9862802656529490, 0.9899491476891340, 0.9924927015384200, 0.9941456804052560, 0.9951839750332120, 0.9957567501108180, 0.9959128182867100, 0.9956061578345280, 0.9945976009618540, 0.9922157154923700, 0.9862364527832490, 0.9679433372645410, 0.8912850042449430, 0.5362024778620530, 0.1541081190018780, 0.0574575093228929, 0.0315349873107007, 0.0222633920086335, 0.0182022841492439, 0.0162990559732640, 0.0153656239334613, 0.0149111568733976, 0.0146954339898235, 0.0145964146717719, 0.0145470156699655, 0.0145228771899495, 0.0145120341118965, 0.0145066940939832, 0.0145044507314479, 0.0145038009464639 };
static const float BASE_M[38] = { 0.9906735573199880, 0.9906715249619790, 0.9906625823534210, 0.9906181076447950, 0.9904514808787100, 0.9898710814002040, 0.9882866087596400, 0.9842906927975040, 0.9739349056253060, 0.9418178384601450, 0.8173903261951560, 0.4324728050657290, 0.1384539782588700, 0.0537347216940033, 0.0292174996673231, 0.0213136517508590, 0.0201349530181136, 0.0241323096280662, 0.0372236145223627, 0.0760506552706601, 0.2053754719423990, 0.5412689034604390, 0.8158416850864860, 0.9128177041239760, 0.9463398301669620, 0.9599276963319910, 0.9662605952303120, 0.9693259700584240, 0.9708545367213990, 0.9716050665281280, 0.9719627697573920, 0.9721272722745090, 0.9722094177458120, 0.9722495776784240, 0.9722676219987420, 0.9722765094621500, 0.9722802433068740, 0.9722813248265600 };
static const float BASE_Y[38] = { 0.0210523371789306, 0.0210564627517414, 0.0210746178695038, 0.0211649058448753, 0.0215027957272504, 0.0226738799041561, 0.0258235649693629, 0.0334879385639851, 0.0519069663740307, 0.1007490148334730, 0.2391298997068470, 0.5348043122727480, 0.7978075786430300, 0.9114498940673840, 0.9537979630045070, 0.9712416154654290, 0.9793031238075880, 0.9833801195075750, 0.9854612465677550, 0.9864350469766050, 0.9867382506701410, 0.9866178824450320, 0.9862777767586430, 0.9858605924440560, 0.9854749276762100, 0.9851769347655580, 0.9849715740141810, 0.9848463034157120, 0.9847753518111990, 0.9847380666252650, 0.9847196483117650, 0.9847110233919390, 0.9847066833006760, 0.9847045543930910, 0.9847035963093700, 0.9847031240775520, 0.9847029256150900, 0.9847028681227950 };
static const float BASE_R[38] = { 0.0315605737777207, 0.0315520718330149, 0.0315148215513658, 0.0313318044982702, 0.0306729857725527, 0.0286480476989607, 0.0246450407045709, 0.0192960753663651, 0.0142066612220556, 0.0102942608878609, 0.0076191460521811, 0.0058980410835420, 0.0048233247781713, 0.0042298748350633, 0.0040599171299341, 0.0043533695594676, 0.0053434425970201, 0.0076917201010463, 0.0135969795736536, 0.0316975442661115, 0.1078611963552490, 0.4638126031687040, 0.8470554052720110, 0.9431854093939180, 0.9688621506965580, 0.9780306674736030, 0.9820436438543060, 0.9839236237187070, 0.9848454841543820, 0.9852942758145960, 0.9855072952198250, 0.9856050715398370, 0.9856538499335780, 0.9856776850338830, 0.9856883918061220, 0.9856936646900310, 0.9856958798482050, 0.9856965214637620 };
static const float BASE_G[38] = { 0.0095560747554212, 0.0095581580120851, 0.0095673245444588, 0.0096129126297349, 0.0097837090401843, 0.0103786227058710, 0.0120026452378567, 0.0160977721473922, 0.0267061902231680, 0.0595555440185881, 0.1860398265328260, 0.5705798201161590, 0.8614677684002920, 0.9458790897676580, 0.9704654864743050, 0.9784136302844500, 0.9795890314112240, 0.9755335369086320, 0.9622887553978130, 0.9231215745131200, 0.7934340189431110, 0.4592701359024290, 0.1855741036663030, 0.0881774959955372, 0.0543630228766700, 0.0406288447060719, 0.0342215204316970, 0.0311185790956966, 0.0295708898336134, 0.0288108739348928, 0.0284486271324597, 0.0282820301724731, 0.0281988376490237, 0.0281581655342037, 0.0281398910216386, 0.0281308901665811, 0.0281271086805816, 0.0281260133612096 };
static const float BASE_B[38] = { 0.9794047525020140, 0.9794007068431300, 0.9793829034702610, 0.9792943649455940, 0.9789630146085700, 0.9778144666940430, 0.9747243211338360, 0.9671984823439730, 0.9490796575305750, 0.9008501289409770, 0.7631504454622400, 0.4659221716493190, 0.2012632804510050, 0.0877524413419623, 0.0457176793291679, 0.0284706050521843, 0.0205271767569850, 0.0165302792310211, 0.0145135107212858, 0.0136003508637687, 0.0133604258769571, 0.0135488943145680, 0.0139594356366992, 0.0144434255753570, 0.0148854440621406, 0.0152254296999746, 0.0154592848180209, 0.0156018026485961, 0.0156824871281936, 0.0157248764360615, 0.0157458108784121, 0.0157556123350225, 0.0157605443964911, 0.0157629637515278, 0.0157640525629106, 0.0157645892329510, 0.0157648147772649, 0.0157648801149616 };

// The CIE 1931 observer, with the illuminant in the weights (x, y, z).
static const float CMF_X[38] = { 0.0000646919989576, 0.0002194098998132, 0.0011205743509343, 0.0037666134117111, 0.0118805536037990, 0.0232864424191771, 0.0345594181969747, 0.0372237901162006, 0.0324183761091486, 0.0212332056093810, 0.0104909907685421, 0.0032958375797931, 0.0005070351633801, 0.0009486742057141, 0.0062737180998318, 0.0168646241897775, 0.0286896490259810, 0.0426748124691731, 0.0562547481311377, 0.0694703972677158, 0.0830531516998291, 0.0861260963002257, 0.0904661376847769, 0.0850038650591277, 0.0709066691074488, 0.0506288916373645, 0.0354739618852640, 0.0214682102597065, 0.0125164567619117, 0.0068045816390165, 0.0034645657946526, 0.0014976097506959, 0.0007697004809280, 0.0004073680581315, 0.0001690104031614, 0.0000952245150365, 0.0000490309872958, 0.0000199961492222 };
static const float CMF_Y[38] = { 0.0000018442894440, 0.0000062053235865, 0.0000310096046799, 0.0001047483849269, 0.0003536405299538, 0.0009514714056444, 0.0022822631748318, 0.0042073290434730, 0.0066887983719014, 0.0098883960193565, 0.0152494514496311, 0.0214183109449723, 0.0334229301575068, 0.0513100134918512, 0.0704020839399490, 0.0878387072603517, 0.0942490536184085, 0.0979566702718931, 0.0941521856862608, 0.0867810237486753, 0.0788565338632013, 0.0635267026203555, 0.0537414167568200, 0.0426460643574120, 0.0316173492792708, 0.0208852059213910, 0.0138601101360152, 0.0081026402038399, 0.0046301022588030, 0.0024913800051319, 0.0012593033677378, 0.0005416465221680, 0.0002779528920067, 0.0001471080673854, 0.0000610327472927, 0.0000343873229523, 0.0000177059860053, 0.0000072209749130 };
static const float CMF_Z[38] = { 0.0003050171476380, 0.0010368066663574, 0.0053131363323992, 0.0179543925899536, 0.0570775815345485, 0.1136516189362870, 0.1733587261835500, 0.1962065755586570, 0.1860823707062960, 0.1399504753832070, 0.0891745294268649, 0.0478962113517075, 0.0281456253957952, 0.0161376622950514, 0.0077591019215214, 0.0042961483736618, 0.0020055092122156, 0.0008614711098802, 0.0003690387177652, 0.0001914287288574, 0.0001495555858975, 0.0000923109285104, 0.0000681349182337, 0.0000288263655696, 0.0000157671820553, 0.0000039406041027, 0.0000015840125870, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000, 0.0000000000000000 };

float uncompand(float x) { return x < 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
float compand(float x) { return x < 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float3 toLinear(float3 c) { return float3(uncompand(c.r), uncompand(c.g), uncompand(c.b)); }
float3 toSrgb(float3 c) { return saturate(float3(compand(c.r), compand(c.g), compand(c.b))); }

// A linear RGB color's reflectance curve: its white, its secondaries and primaries, each a base
// curve.
void reflectance(float3 c, out float R[38])
{
    float w = min(c.r, min(c.g, c.b));
    c -= w;
    float cy = min(c.g, c.b);
    float m = min(c.r, c.b);
    float y = min(c.r, c.g);
    float r = min(max(0.0, c.r - c.b), max(0.0, c.r - c.g));
    float g = min(max(0.0, c.g - c.b), max(0.0, c.g - c.r));
    float b = min(max(0.0, c.b - c.g), max(0.0, c.b - c.r));
    for (int i = 0; i < 38; i++)
        R[i] = max(SPECTRAL_EPSILON, w * BASE_W[i] + cy * BASE_C[i] + m * BASE_M[i] + y * BASE_Y[i] + r * BASE_R[i] + g * BASE_G[i] + b * BASE_B[i]);
}

float3 toXyz(float R[38])
{
    float3 xyz = 0.0;
    for (int i = 0; i < 38; i++)
        xyz += R[i] * float3(CMF_X[i], CMF_Y[i], CMF_Z[i]);
    return xyz;
}

float luminance(float R[38])
{
    float y = 0.0;
    for (int i = 0; i < 38; i++)
        y += R[i] * CMF_Y[i];
    return y;
}

float3 xyzToSrgb(float3 xyz)
{
    float r = dot(float3(3.2409699419045200, -1.537383177570090, -0.4986107602930030), xyz);
    float g = dot(float3(-0.9692436362808790, 1.875967501507720, 0.0415550574071756), xyz);
    float b = dot(float3(0.0556300796969936, -0.203976958888976, 1.0569715142428700), xyz);
    return toSrgb(float3(r, g, b));
}

float KS(float R) { return (1.0 - R) * (1.0 - R) / (2.0 * R); }
// 1 + ks - sqrt(ks^2 + 2 ks), as 1 / (1 + ks + sqrt(ks^2 + 2 ks)): the same, without the
// cancellation that makes noise of dark paint (large ks) in 32-bit floats.
float KM(float ks) { return 1.0 / (1.0 + ks + sqrt(ks * ks + 2.0 * ks)); }

// Linear sRGB of an XYZ color, not clamped.
float3 xyzToLinear(float3 xyz)
{
    return float3(
        dot(float3(3.2409699419045200, -1.537383177570090, -0.4986107602930030), xyz),
        dot(float3(-0.9692436362808790, 1.875967501507720, 0.0415550574071756), xyz),
        dot(float3(0.0556300796969936, -0.203976958888976, 1.0569715142428700), xyz));
}

// Two paints by their K/S curves and concentrations (spectral.js spectral_mix with tinting
// strength 1; the 2D app's spectral_km): linear sRGB, not clamped.
float3 spectralKm(float K1[38], float K2[38], float c1, float c2)
{
    float total = max(c1 + c2, SPECTRAL_EPSILON);
    float R[38];
    for (int i = 0; i < 38; i++)
        R[i] = KM((K1[i] * c1 + K2[i] * c2) / total);
    return xyzToLinear(toXyz(R));
}

// OKLab (Bjorn Ottosson), from linear sRGB.
float3 oklab(float3 c)
{
    float3 lms = float3(
        dot(float3(0.4122214708, 0.5363325363, 0.0514459929), c),
        dot(float3(0.2119034982, 0.6806995451, 0.1073969566), c),
        dot(float3(0.0883024619, 0.2817188376, 0.6299787005), c));
    lms = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return float3(
        dot(float3(0.2104542553, 0.7936177850, -0.0040720468), lms),
        dot(float3(1.9779984951, -2.4285922050, 0.4505937099), lms),
        dot(float3(0.0259040371, 0.7827717662, -0.8086757660), lms));
}

// Linear sRGB of an OKLab color, not clamped.
float3 oklabToLinear(float3 lab)
{
    float3 l = float3(
        dot(float3(1.0, 0.3963377774, 0.2158037573), lab),
        dot(float3(1.0, -0.1055613458, -0.0638541728), lab),
        dot(float3(1.0, -0.0894841775, -1.2914855480), lab));
    l = l * l * l;
    return float3(
        dot(float3(4.0767416621, -3.3077115913, 0.2309699292), l),
        dot(float3(-1.2684380046, 2.6097574011, -0.3413193965), l),
        dot(float3(-0.0041960863, -0.7034186147, 1.7076147010), l));
}

float overshoot(float3 c) { return max(max(max(c.r, c.g), c.b) - 1.0, -min(min(c.r, c.g), c.b)); }

// sRGB of an OKLab color, into the gamut with its hue kept (the 2D app's srgb): along the line
// to a grey (L0, 0, 0) (Bjorn Ottosson's adaptive L0 projection, alpha 0.05), by bisection.
// Near the corners of the gamut (pure blue, green) a hue 1 or 2 degrees off the corner can hold
// much less chroma, so the projection alone would band where a mix grazes the edge. Thus a small
// overshoot clamps (its hue error is small), and the projection takes over by an overshoot of
// 0.02.
float3 oklabToSrgb(float3 lab)
{
    float3 c = oklabToLinear(lab);
    float over = overshoot(c);
    if (over <= 0.0)
        return toSrgb(c);
    float C = length(lab.yz), Ld = lab.x - 0.5, e1 = 0.5 + abs(Ld) + 0.05 * C;
    float3 g = float3(0.5 * (1.0 + sign(Ld) * (e1 - sqrt(max(e1 * e1 - 2.0 * abs(Ld), 0.0)))), 0.0, 0.0);
    float lo = 0.0, hi = 1.0;
    for (int n = 0; n < 12; n++)
    {
        float m = 0.5 * (lo + hi);
        if (overshoot(oklabToLinear(g + (lab - g) * m)) <= 1e-5)
            lo = m;
        else
            hi = m;
    }
    float3 kept = oklab(saturate(oklabToLinear(g + (lab - g) * lo)));
    float3 clamped = oklab(saturate(c));
    return toSrgb(oklabToLinear(lerp(clamped, kept, smoothstep(0.0, 0.02, over))));
}

// Paint d (amount wd) and paint s (amount ws), sRGB: the 2D app's pigment_mix.
//
// Kubelka-Munk at an even rate: where one paint absorbs a band of wavelengths almost fully, a
// trace of it overrules the other paint, so a plain mix by amount stays at the strong paint for
// most of the way and then jumps to the weak one in the last percent. A bisection on the KM
// amount (in logit space) finds the mix that sits the fraction t of the OKLab way from d to s.
//
// Kubelka-Munk alone also mixes red and blue into a grey brown (their curves share almost no
// wavelength). A second mix keeps the lightness and the hue (the short way round) of the two
// paints in OKLab, with less chroma lost (average chroma x cos(dh/2)^0.5 in the middle). The
// more colorful mix wins, smoothly (weights chroma^4): blue and yellow stay the Kubelka-Munk
// green, red and blue make purple.
public float3 pigmentMix(float3 d, float wd, float3 s, float ws)
{
    float t = ws / max(ws + wd, 1e-12);
    float3 ld = toLinear(d), ls = toLinear(s);
    float R[38], K1[38], K2[38];
    reflectance(ld, R);
    float l1 = luminance(R);
    for (int i = 0; i < 38; i++)
        K1[i] = KS(R[i]);
    reflectance(ls, R);
    float l2 = luminance(R);
    for (int i = 0; i < 38; i++)
        K2[i] = KS(R[i]);
    float3 a = oklab(ld), b = oklab(ls);
    // The amount of s is 1 / (1 + e^-z), and the concentrations are amount x luminance
    // (spectral.js).
    float lo = -12.0, hi = 12.0, plo = 0.0, phi = 1.0;
    for (int n = 0; n < 6; n++)
    {
        float z = 0.5 * (lo + hi);
        float3 m = oklab(spectralKm(K1, K2, l1 / (1.0 + exp(z)), l2 / (1.0 + exp(-z))));
        float da = distance(m, a), db = distance(m, b);
        float p = da / (da + db + 1e-9);
        if (p < t)
        {
            lo = z;
            plo = p;
        }
        else
        {
            hi = z;
            phi = p;
        }
    }
    float zm = lerp(lo, hi, saturate((t - plo) / max(phi - plo, 1e-6)));
    float3 k = oklab(spectralKm(K1, K2, l1 / (1.0 + exp(zm)), l2 / (1.0 + exp(-zm))));
    float ca = length(a.yz), cb = length(b.yz);
    float ha = atan2(a.z, a.y), hb = atan2(b.z, b.y);
    if (ca < 1e-4)
        ha = hb; // a grey has no hue: the other paint's
    if (cb < 1e-4)
        hb = ha;
    float x = hb - ha + 3.14159265;
    float dh = x - 6.28318531 * floor(x / 6.28318531) - 3.14159265;
    float h = ha + t * dh;
    float f = 1.0 - (1.0 - sqrt(abs(cos(dh * 0.5)))) * 4.0 * t * (1.0 - t);
    float c = lerp(ca, cb, t) * f;
    float3 v = float3(lerp(a.x, b.x, t), c * cos(h), c * sin(h));
    float ck = length(k.yz), cv = length(v.yz);
    float ck4 = ck * ck * ck * ck, cv4 = cv * cv * cv * cv;
    float w = cv4 / (cv4 + ck4 + 1e-12);
    return oklabToSrgb(lerp(k, v, w));
}

// Paint s (premultiplied sRGB, alpha) onto paint d (the same), as the 2D app's PIGMENT_FS:
// the amounts are the alpha-over coverages, so an opaque stroke still covers and a thin one
// mixes in. Alpha composites as normal.
public float4 pigmentOver(float4 d, float4 s)
{
    if (s.a <= 1e-4)
        return d;
    if (d.a <= 1e-4)
        return s;
    float ws = s.a, wd = d.a * (1.0 - s.a);
    float a = ws + wd;
    float3 c = pigmentMix(saturate(d.rgb / d.a), wd, saturate(s.rgb / s.a), ws);
    return float4(c * a, a);
}

// Paint s clipped to paint d (the 2D app's PIGMENT_FS with uAtop): s mixes in where d has paint,
// by its coverage; d's alpha is kept.
public float4 pigmentAtop(float4 d, float4 s)
{
    if (s.a <= 1e-4 || d.a <= 1e-4)
        return d;
    float3 c = pigmentMix(saturate(d.rgb / d.a), 1.0 - s.a, saturate(s.rgb / s.a), s.a);
    return float4(c * d.a, d.a);
}

// Multiply as paint does it (the 2D app's BLEND_FS spectralMultiply): the reflectance curves
// multiply wavelength by wavelength. White leaves b as it is and it only darkens, but the hues
// are paint's: yellow on blue gives a dark green, not black.
public float3 spectralMultiply(float3 b, float3 s)
{
    float Rb[38], Rs[38];
    reflectance(toLinear(b), Rb);
    reflectance(toLinear(s), Rs);
    for (int i = 0; i < 38; i++)
        Rb[i] *= Rs[i];
    return xyzToSrgb(toXyz(Rb));
}
