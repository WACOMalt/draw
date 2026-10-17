// The 2D app's brush falloff, and its integral along a line: shared by the raymarcher (soft
// stamps) and the canvas bake (2D dab trails). The same as vdraw_core::segments::falloff.
module brush;

// The brush falloff of the 2D app: 1 inside `hard` of the radius, then a raised cosine down
// to 0 at the edge. `u`: the distance from the center, in radii. (vdraw_core::segments::falloff)
public float brushFalloff(float u, float hard)
{
    if (u >= 1.0)
        return 0.0;
    if (u <= hard)
        return 1.0;
    float x = (u - hard) / max(1.0 - hard, 1e-6);
    return 0.5 + 0.5 * cos(3.14159265 * x);
}

// The falloff integrated along a line at distance q (radii) from a stamp's center, from the
// line's nearest point to y further on (radii; negative: backward). The full-density core is
// exact; the falloff shell, which is smooth, by 4-point Gauss.
public float stampLine(float q, float y, float hard)
{
    float sgn = y < 0.0 ? -1.0 : 1.0;
    y = min(abs(y), sqrt(max(1.0 - q * q, 0.0)));
    if (y <= 0.0)
        return 0.0;
    float yc = sqrt(max(hard * hard - q * q, 0.0)); // where the core ends
    float core = min(y, yc);
    float shell = 0.0;
    if (y > yc)
    {
        const float X[2] = { 0.3399810436, 0.8611363116 };
        const float W[2] = { 0.6521451549, 0.3478548451 };
        float mid = 0.5 * (y + yc);
        float half = 0.5 * (y - yc);
        for (uint k = 0; k < 2; k++)
        {
            float s0 = mid - X[k] * half;
            float s1 = mid + X[k] * half;
            shell += W[k] * (brushFalloff(sqrt(q * q + s0 * s0), hard) + brushFalloff(sqrt(q * q + s1 * s1), hard));
        }
        shell *= half;
    }
    return sgn * (core + shell);
}

