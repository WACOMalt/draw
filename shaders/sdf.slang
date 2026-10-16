// Distance functions of vdraw. The same as crates/core/src/sdf.rs (keep both in step).
//
// Portable core: plain functions on float3, no Vulkan-only features (no buffer pointers, no
// subgroups), so Slang can also emit HLSL for a Unity/VRChat port of the renderer.
module sdf;

// Signed distance from p to a round cone: the hull of a sphere at a (radius ra) and a sphere at
// b (radius rb). Exact (Inigo Quilez). When one sphere holds the other, the larger sphere.
public float sdRoundCone(float3 p, float3 a, float ra, float3 b, float rb)
{
    float3 ba = b - a;
    float l2 = dot(ba, ba);
    float rr = ra - rb;
    if (rr * rr >= l2)
        return ra >= rb ? length(p - a) - ra : length(p - b) - rb;
    float a2 = l2 - rr * rr;
    float il2 = 1.0 / l2;
    float3 pa = p - a;
    float y = dot(pa, ba);
    float z = y - l2;
    float3 w = pa * l2 - ba * y;
    float x2 = dot(w, w);
    float y2 = y * y * l2;
    float z2 = z * z * l2;
    float k = sign(rr) * rr * rr * x2;
    if (sign(z) * a2 * z2 > k)
        return sqrt(x2 + z2) * il2 - rb;
    if (sign(y) * a2 * y2 < k)
        return sqrt(x2 + y2) * il2 - ra;
    return (sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

// Where a ray (from o, unit dir) first enters a sphere: x = t (negative: a miss, or the ray
// starts inside), yzw = the normal there.
public float4 rayEnterSphere(float3 o, float3 dir, float3 c, float r)
{
    float3 oc = o - c;
    float b = dot(oc, dir);
    float h = b * b - (dot(oc, oc) - r * r);
    if (h < 0.0)
        return float4(-1.0, 0.0, 0.0, 0.0);
    float t = -b - sqrt(h);
    return float4(t, (oc + dir * t) / r);
}

// Where a ray (from o, unit dir) first enters a round cone: x = t (negative: a miss, or the
// ray starts inside), yzw = the normal there. Exact (Inigo Quilez, "rounded cone
// intersection"). The same as ray_round_cone in crates/core/src/sdf.rs, which is tested.
public float4 rayRoundCone(float3 o, float3 dir, float3 a, float ra, float3 b, float rb)
{
    float3 ba = b - a;
    float m0 = dot(ba, ba);
    float rr = ra - rb;
    if (rr * rr >= m0)
        return ra >= rb ? rayEnterSphere(o, dir, a, ra) : rayEnterSphere(o, dir, b, rb);
    float3 oa = o - a;
    float m1 = dot(ba, oa);
    float m2 = dot(ba, dir);
    float m3 = dot(dir, oa);
    float m5 = dot(oa, oa);
    // The side: a quadratic in t.
    float d2 = m0 - rr * rr;
    float k2 = d2 - m2 * m2;
    float k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
    float k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
    float h = k1 * k1 - k0 * k2;
    if (h < 0.0)
        return float4(-1.0, 0.0, 0.0, 0.0);
    float t = (-sqrt(h) - k1) / k2;
    float y = m1 - ra * rr + t * m2;
    if (y > 0.0 && y < d2)
        return float4(t, normalize(d2 * (oa + dir * t) - ba * y));
    // The ends: the first entry of either sphere.
    float4 ea = rayEnterSphere(o, dir, a, ra);
    float4 eb = rayEnterSphere(o, dir, b, rb);
    if (ea.x < 0.0)
        return eb;
    if (eb.x < 0.0)
        return ea;
    return ea.x <= eb.x ? ea : eb;
}

// Smooth minimum (polynomial): blends two distances over k.
public float smin(float a, float b, float k)
{
    if (k <= 0.0)
        return min(a, b);
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

// A segment as stored: a.xyz, a.w = radius at a; b.xyz, b.w = radius at b; color = linear RGB
// and opacity; style.x = hardness, style.y = stroke number; shape.xyz = the tip's flat axis,
// shape.w = its roundness (1: round). Five float4, so a port can read it from a float texture
// (five texels).
public struct Segment
{
    public float4 a;
    public float4 b;
    public float4 color;
    public float4 style;
    public float4 shape;
}

// A vector in the segment's round space: stretched along its flat axis by 1 / roundness,
// where its tip (flattened along that axis) is round again.
public float3 stretch(Segment s, float3 v)
{
    return v + s.shape.xyz * ((1.0 / s.shape.w - 1.0) * dot(s.shape.xyz, v));
}

// A segment and a ray (from o, unit dir) in the segment's round space (around its point a, for
// precision). There the tip is round, so the round-cone and stamp math holds as it is.
// `scale`: distances along the ray there are `scale` times those in the world. A round
// segment stays as it is (scale 1).
public Segment roundSpace(Segment s, inout float3 o, inout float3 dir, out float scale)
{
    scale = 1.0;
    if (s.shape.w >= 0.999)
        return s;
    Segment r = s;
    r.a.xyz = float3(0.0);
    r.b.xyz = stretch(s, s.b.xyz - s.a.xyz);
    o = stretch(s, o - s.a.xyz);
    float3 d = stretch(s, dir);
    scale = length(d);
    dir = d / scale;
    return r;
}

// Opaque with a hard edge: a surface. Else a volume.
public bool isSolid(Segment s)
{
    return s.color.a >= 0.999 && s.style.x >= 0.999;
}

// Where a ray first enters a segment: x = t, yzw = the normal (as rayRoundCone), the tip
// flattened along the segment's axis (an exact hit: the round cone in the round space).
public float4 raySegment(float3 o, float3 dir, Segment s)
{
    float scale;
    Segment r = roundSpace(s, o, dir, scale);
    float4 hit = rayRoundCone(o, dir, r.a.xyz, r.a.w, r.b.xyz, r.b.w);
    if (scale == 1.0 || hit.x < 0.0)
        return hit;
    // Normals go back by the same stretch (the stretch is symmetric).
    return float4(hit.x / scale, normalize(stretch(s, hit.yzw)));
}

public float sdSegment(float3 p, Segment s)
{
    return sdRoundCone(p, s.a.xyz, s.a.w, s.b.xyz, s.b.w);
}

// The sphere that holds a segment: center xyz, radius w.
public float4 segmentBounds(Segment s)
{
    float3 c = (s.a.xyz + s.b.xyz) * 0.5;
    return float4(c, length(s.b.xyz - s.a.xyz) * 0.5 + max(s.a.w, s.b.w));
}

// Ray against a sphere: the entry and exit distances along the ray (dir normalized). x > y
// when the ray misses.
public float2 raySphere(float3 o, float3 dir, float4 sphere)
{
    float3 oc = o - sphere.xyz;
    float b = dot(oc, dir);
    float c = dot(oc, oc) - sphere.w * sphere.w;
    float h = b * b - c;
    if (h < 0.0)
        return float2(1.0, -1.0);
    h = sqrt(h);
    return float2(-b - h, -b + h);
}
