// The panels: egui's meshes, flat in points, stood up in the room by one matrix (clip space
// from panel points), drawn over the painting into the sRGB swapchain.
//
// egui's colors are sRGB and premultiplied. The target is sRGB and blends in linear, so the
// vertex color is made linear here and its alpha is left alone (as egui's own backends do).
// egui leaves the cut to each mesh's clip rectangle to the renderer: on a desktop a scissor,
// here a test in panel points, because the panel is a quad in the room.

struct Push
{
    float4x4 clipFromPoint;
    float4 clip; // min x, min y, max x, max y, in points
};
[[vk::push_constant]] ConstantBuffer<Push> push;
[[vk::binding(0, 0)]] Sampler2D tex;

struct VsIn
{
    [[vk::location(0)]] float2 pos : POSITION;
    [[vk::location(1)]] float2 uv : TEXCOORD0;
    [[vk::location(2)]] float4 color : COLOR0;
};

struct VsOut
{
    float4 position : SV_Position;
    [[vk::location(0)]] float2 uv : TEXCOORD0;
    [[vk::location(1)]] float4 color : COLOR0;
    [[vk::location(2)]] float2 point : TEXCOORD1;
};

float3 linearFromSrgb(float3 c)
{
    float3 low = c / 12.92;
    float3 high = pow((c + 0.055) / 1.055, float3(2.4));
    return lerp(low, high, step(0.04045, c));
}

[shader("vertex")]
VsOut vsMain(VsIn v)
{
    VsOut o;
    o.position = mul(push.clipFromPoint, float4(v.pos, 0.0, 1.0));
    o.uv = v.uv;
    o.color = float4(linearFromSrgb(v.color.rgb), v.color.a);
    o.point = v.pos;
    return o;
}

[shader("fragment")]
float4 fsMain(VsOut i) : SV_Target
{
    if (any(i.point < push.clip.xy) || any(i.point > push.clip.zw))
        discard;
    return i.color * tex.Sample(i.uv);
}
