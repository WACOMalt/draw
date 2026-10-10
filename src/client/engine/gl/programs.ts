// GLSL programs for the WebGL2 renderer.
//
// Conventions: every offscreen target uses "image space": pixel row 0 is the top of the image,
// and texture v = 0 is that top row. Only the present pass, which draws to the canvas, flips Y.
// All colors are premultiplied by alpha.

const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;   // 0..1
uniform vec4 uDst;      // x, y, w, h in target pixels
uniform vec4 uSrc;      // u0, v0, u1, v1
uniform vec2 uTarget;   // target size in pixels
uniform float uFlipY;   // 1 for the default framebuffer
out vec2 vUv;
out vec2 vScreen;       // 0..1 position in the target, for reading a same-size backdrop
void main() {
  vec2 p = uDst.xy + aCorner * uDst.zw;
  vUv = mix(uSrc.xy, uSrc.zw, aCorner);
  vScreen = p / uTarget;
  vec2 ndc = vScreen * 2.0 - 1.0;
  if (uFlipY > 0.5) ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

/**
 * A screen-sized texture drawn through an affine transform (target pixels from source pixels):
 * the live preview of a layer transform. Affine, so the texture coordinates stay linear.
 */
const XFORM_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;   // 0..1
uniform mat3 uM;        // source pixel -> target pixel
uniform vec2 uSrcSize;  // source size in pixels
uniform vec2 uTarget;   // target size in pixels
out vec2 vUv;
void main() {
  vec2 p = (uM * vec3(aCorner * uSrcSize, 1.0)).xy;
  vUv = aCorner;
  gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Texture copy, scaled by an opacity. Used for tiles, stroke buffers and layers. */
const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 o;
void main() { o = texture(uTex, vUv) * uOpacity; }`;

/** Final output: half-float composite to the 8-bit canvas, with dither to hide banding. */
const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uDither;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(uTex, vUv);
  float n = (hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 7.1) - 1.0) / 255.0; // triangular
  o = vec4(clamp(c.rgb + n * uDither, 0.0, 1.0), 1.0);
}`;

/**
 * One brush dab per instance. The CPU computes positions in target pixels in double precision,
 * relative to the target origin, so deep zoom stays exact in float32.
 * Huge dabs (radius over 1e6 px) arrive with a quad over the target only (half size rv) and
 * the edge data of putDab (aEdge, aHuge.x), plus the true radius (r) for the hardness profile.
 */
const DAB_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;   // 0..1
layout(location = 1) in vec4 aDab;      // cx, cy, rv, alpha
layout(location = 2) in float aR;       // true radius in px
layout(location = 3) in vec2 aRot;      // cos and sin of the tip rotation
layout(location = 4) in vec4 aPaint;    // r, g, b, hardness (per dab: strokes share draw calls)
layout(location = 5) in vec3 aHuge;     // huge dab: depth outside the edge (D), true center x, y
layout(location = 6) in vec3 aEdge;     // huge dab: w x, y, b (b = 0: not huge)
uniform vec2 uTarget;
out vec2 vLocal;
flat out float vRv;
flat out float vR;
flat out float vA;
flat out vec2 vRot;
flat out vec3 vColor;
flat out float vHardness;
flat out float vD;
flat out vec2 vTrue;
flat out vec3 vEdge;
void main() {
  float ext = aDab.z + 1.0;               // one pixel margin for the antialiased edge
  vLocal = (aCorner * 2.0 - 1.0) * ext;
  vRv = aDab.z;
  vR = aR;
  vA = aDab.w;
  vRot = aRot;
  vColor = aPaint.rgb;
  vHardness = aPaint.a;
  vD = aHuge.x;
  vTrue = aHuge.yz;
  vEdge = aEdge;
  vec2 p = aDab.xy + vLocal;
  gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * One dab. The round tip is analytic (hardness profile). Other tips come from a texture array
 * (uTip = layer, -1 = round). Every tip lies inside the unit circle, so the dab quad covers it
 * at any rotation. Roundness squashes the tip along its height. Grain multiplies the alpha with
 * a tileable texture in stroke space (uGrainOrigin, uGrainPx in target pixels).
 */
const DAB_FS = `#version 300 es
precision highp float;
precision mediump sampler2DArray;
in vec2 vLocal;
flat in float vRv;
flat in float vR;
flat in float vA;
flat in vec2 vRot;
flat in vec3 vColor;
flat in float vHardness;
flat in float vD;
flat in vec2 vTrue;
flat in vec3 vEdge;
uniform int uTip;
uniform float uRoundness;
uniform sampler2DArray uTips;
uniform int uGrain;
uniform sampler2DArray uGrains;
uniform float uGrainStrength;
uniform vec2 uGrainOrigin;
uniform float uGrainPx;
out vec4 o;
const float PI = 3.14159265359;
void main() {
  float c = vRot.x, s = vRot.y;
  vec2 q = vec2(c * vLocal.x + s * vLocal.y, -s * vLocal.x + c * vLocal.y);
  q.y /= uRoundness;
  float a;
  if (uTip < 0) {
    float edge;                           // pixels inside the edge, in dab space
    if (vEdge.z > 0.0) {
      // Huge: q is relative to the target center. R - |q + v| = -(|q + v|² - R²) / (|q + v| + R),
      // with numerator and denominator times b: no huge numbers cancel (see putDab).
      float b = vEdge.z;
      float n = b * dot(q, q) + 2.0 * dot(q, vEdge.xy) + vD;
      edge = -n / (length(vEdge.xy + q * b) + 1.0 - length(vEdge.xy));
    } else edge = vRv - length(q);
    if (edge <= -0.5) discard;
    float t = clamp(1.0 - edge / vR, 0.0, 1.0); // 0 at the center, 1 at the edge
    a = 1.0;
    if (t > vHardness) {
      float x = (t - vHardness) / max(1.0 - vHardness, 1e-6);
      a = 0.5 + 0.5 * cos(PI * x);
    }
    a *= clamp(edge + 0.5, 0.0, 1.0);    // one pixel of antialiasing
  } else {
    // Relative to the true center (vTrue is 0 unless the dab is huge), in units of its radius.
    vec2 l = vLocal - vTrue;
    vec2 qt = vec2(c * l.x + s * l.y, -s * l.x + c * l.y);
    qt.y /= uRoundness;
    vec2 uv = qt / max(vR, 1e-6) * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
    a = texture(uTips, vec3(uv, float(uTip))).r;
  }
  if (uGrain >= 0) {
    float g = texture(uGrains, vec3((gl_FragCoord.xy - uGrainOrigin) / uGrainPx, float(uGrain))).r;
    a *= mix(1.0, g, uGrainStrength);
  }
  a *= vA;
  if (a <= 0.0) discard;
  o = vec4(vColor * a, a);
}`;

/** Layer blend modes (W3C Compositing and Blending Level 1), premultiplied in and out. */
const BLEND_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vScreen;
uniform sampler2D uBack;   // composite so far
uniform sampler2D uLayer;  // this layer
uniform float uOpacity;
uniform int uMode;
uniform int uAtop;         // 1: clipped layer, only where the backdrop (the clip base) has alpha
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 blend(vec3 b, vec3 s) {
  if (uMode == 1) return b * s;                                        // multiply
  if (uMode == 2) return b + s - b * s;                                // screen
  if (uMode == 3) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b)); // overlay
  if (uMode == 4) return min(b, s);                                    // darken
  if (uMode == 5) return max(b, s);                                    // lighten
  if (uMode == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (uMode == 7) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (uMode == 8) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (uMode == 9) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (uMode == 10) return abs(b - s);                                  // difference
  if (uMode == 11) return b + s - 2.0 * b * s;                         // exclusion
  if (uMode == 12) return setLum(setSat(s, sat(b)), lum(b));           // hue
  if (uMode == 13) return setLum(setSat(b, sat(s)), lum(b));           // saturation
  if (uMode == 14) return setLum(s, lum(b));                           // color
  if (uMode == 15) return setLum(b, lum(s));                           // luminosity
  if (uMode == 16) return min(b + s, vec3(1.0));                       // add (linear dodge)
  return s;                                                            // normal
}
void main() {
  vec4 bk = texture(uBack, vScreen);
  vec4 sc = texture(uLayer, vUv) * uOpacity;
  vec3 cb = bk.a > 0.0 ? clamp(bk.rgb / bk.a, 0.0, 1.0) : vec3(0.0);
  vec3 cs = sc.a > 0.0 ? clamp(sc.rgb / sc.a, 0.0, 1.0) : vec3(0.0);
  vec3 mixed = clamp(blend(cb, cs), 0.0, 1.0);
  if (uAtop == 1) {
    o = vec4(bk.rgb * (1.0 - sc.a) + sc.a * bk.a * mixed, bk.a);
    return;
  }
  vec3 co = sc.rgb * (1.0 - bk.a) + bk.rgb * (1.0 - sc.a) + sc.a * bk.a * mixed;
  o = vec4(co, sc.a + bk.a * (1.0 - sc.a));
}`;

/**
 * Layer mask: the mask buffer holds grey paint (premultiplied) over an implied white. Visibility
 * v = grey + (1 - alpha). Output alpha 1 - v, drawn with blend (ZERO, ONE_MINUS_SRC_ALPHA),
 * multiplies the layer by v.
 */
const MASK_FS = `#version 300 es
precision highp float;
in vec2 vScreen;
uniform sampler2D uMask;
out vec4 o;
void main() {
  vec4 m = texture(uMask, vScreen);
  float v = clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)) + 1.0 - m.a, 0.0, 1.0);
  o = vec4(0.0, 0.0, 0.0, 1.0 - v);
}`;

/**
 * Adjustment layer: changes the composite below it. uType 0: tone curve from a lookup texture
 * (levels, curves, brightness/contrast), applied to each channel. uType 1: hue/saturation.
 * The amount is the layer opacity times the mask visibility. Alpha stays as it is.
 */
const ADJUST_FS = `#version 300 es
precision highp float;
in vec2 vScreen;
uniform sampler2D uBack;
uniform sampler2D uLut;
uniform sampler2D uMask;
uniform int uMaskOn;
uniform int uType;
uniform vec3 uHsl;        // hue shift (turns), saturation, lightness (-1..1)
uniform float uOpacity;
out vec4 o;
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0));
}
float lut(float x) { return texture(uLut, vec2(clamp(x, 0.0, 1.0) * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).r; }
void main() {
  vec4 bk = texture(uBack, vScreen);
  float amount = uOpacity;
  if (uMaskOn == 1) {
    vec4 m = texture(uMask, vScreen);
    amount *= clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)) + 1.0 - m.a, 0.0, 1.0);
  }
  if (bk.a <= 0.0 || amount <= 0.0) { o = bk; return; }
  vec3 c = clamp(bk.rgb / bk.a, 0.0, 1.0);
  vec3 r;
  if (uType == 0) {
    r = vec3(lut(c.r), lut(c.g), lut(c.b));
  } else {
    vec3 h = rgb2hsl(c);
    h.x += uHsl.x;
    h.y = uHsl.y >= 0.0 ? h.y + (1.0 - h.y) * uHsl.y : h.y * (1.0 + uHsl.y);
    h.z = uHsl.z >= 0.0 ? h.z + (1.0 - h.z) * uHsl.z : h.z * (1.0 + uHsl.z);
    r = hsl2rgb(clamp(h, vec3(-10.0, 0.0, 0.0), vec3(10.0, 1.0, 1.0)));
  }
  o = vec4(mix(bk.rgb, r * bk.a, amount), bk.a);
}`;

export interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  const u: Program['u'] = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

export function createPrograms(gl: WebGL2RenderingContext) {
  const quad = ['uDst', 'uSrc', 'uTarget', 'uFlipY'];
  return {
    copy: link(gl, QUAD_VS, COPY_FS, [...quad, 'uTex', 'uOpacity']),
    xform: link(gl, XFORM_VS, COPY_FS, ['uM', 'uSrcSize', 'uTarget', 'uTex', 'uOpacity']),
    present: link(gl, QUAD_VS, PRESENT_FS, [...quad, 'uTex', 'uDither']),
    blend: link(gl, QUAD_VS, BLEND_FS, [...quad, 'uBack', 'uLayer', 'uOpacity', 'uMode', 'uAtop']),
    mask: link(gl, QUAD_VS, MASK_FS, [...quad, 'uMask']),
    adjust: link(gl, QUAD_VS, ADJUST_FS, [...quad, 'uBack', 'uLut', 'uMask', 'uMaskOn', 'uType', 'uHsl', 'uOpacity']),
    dab: link(gl, DAB_VS, DAB_FS, [
      'uTarget',
      'uTip',
      'uRoundness',
      'uTips',
      'uGrain',
      'uGrains',
      'uGrainStrength',
      'uGrainOrigin',
      'uGrainPx',
    ]),
  };
}

export type Programs = ReturnType<typeof createPrograms>;
