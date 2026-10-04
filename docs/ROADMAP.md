# Roadmap: Photoshop-style features

Status: items 1 to 4 are in progress. Items 5 to 8 are planned.

Each item adds to the same parts of the code:

- Data model: `Layer` and `Brush` in `src/shared/types.ts`, with checks in `src/shared/validate.ts`.
- WebGL2 renderer (`src/client/engine/gl/`): 256 px tiles for each layer and level of detail (LOD), then a composite pass for each frame. The blend shader is in `programs.ts`.
- Canvas 2D fallback: `src/client/engine/compositor.ts` and `tile.worker.ts`.

The main constraint is infinite zoom. A feature that is defined in world units, from the stroke vectors, works tile by tile at all zoom levels. A feature that reads existing pixels has no fixed resolution to work at.

Effort: S (small), M, L, XL (changes the document model).

## 1. Adjustment layers (S)

Levels, curves, hue and saturation, brightness and contrast.

- Data: `Layer.kind: 'paint' | 'adjust'` and `Layer.adjust: { type, params }`. The existing `layer.add` and `layer.update` ops carry them.
- Render: an adjustment layer is one full-screen pass. It reads the composite of the layers below, applies the adjustment, and mixes the result by the layer opacity. The composite already alternates between two buffers for blend modes. Curves and levels use a 256-entry lookup texture.
- Canvas 2D fallback: `ctx.filter` covers brightness, contrast, saturation, and hue rotation.
- Cost: one screen pass for each adjustment layer, on each frame that draws.

## 2. Clipping masks (S)

- Data: `Layer.clip: boolean`. A clipped layer clips to the nearest layer below it that is not clipped (the base).
- Render: draw the base into a group buffer. Draw each clipped layer with its blend mode, but only where the base has alpha ("source-atop"). Then composite the group with the blend mode and opacity of the base.
- UI: a clip toggle in the layer row. Clipped layers show an indent.
- Canvas 2D fallback: `globalCompositeOperation = 'source-atop'` on an offscreen canvas.

## 3. Layer masks (M)

- Data: `Layer.mask: { enabled, inverted } | null`, and `Stroke.mask?: true`. Mask strokes are normal strokes. Black paint hides, white paint or the eraser reveals. Thus undo, sync, live strokes, and `.bdraw` files work with no new mechanism.
- Tiles: mask strokes have their own index and tile set, with the key `<layerId>#mask`.
- Render: one shader with two textures multiplies the layer tile by `1 - hidden` from the mask tile. A missing mask tile hides nothing.
- UI: a mask thumbnail next to the layer. A click on it sends the brush to the mask.
- Compatibility: `.bdraw` version 2. The server sends a feature list, so an old client asks for an update and does not draw the canvas wrong.
- Cost: one more tile set for each masked layer.

## 4. Brush textures and dynamics (M)

- Data (`Brush`): `tip` (an ID from a built-in set), `angle`, `roundness`, `followDirection`, jitter for size, angle, scatter and opacity, and `grain: { id, scale, strength }`. A tip ID never changes after a release, so old drawings do not change.
- Determinism: each random value comes from a stateless hash of the stroke seed and the dab index, not from a running generator. A tile renders only a part of a stroke, so it must get the same values as all other tiles and clients. The seed comes from the stroke ID.
- Shader: the dab vertex shader gets angle and roundness for each dab. The fragment shader samples the tip from a texture array with mipmaps, and selects the mip level from the dab radius. Grain is sampled in stroke space and scaled by the brush size, so it stays the same at all zoom levels.
- Canvas 2D fallback: the tile worker stamps rotated tip images and multiplies by a grain pattern.
- Cost: one texture read for each fragment.

## 5. Layer FX and live blur (L)

Drop shadow, outer and inner glow, outline, bevel, and Gaussian blur.

- Data: `Layer.fx: Array<{ type, ... }>`. All radii and distances are in world units.
- LOD method: convert the radius to device pixels at the current zoom. Up to about 8 px, use a full-resolution separable blur. For a larger radius, render the layer from a coarser tile LOD, where the radius is about 8 px. Blur there, then scale up with linear filtering. The cost stays almost constant at all zoom levels.
- Margin: render more tiles around the view, as far as the effect radius, so that off-screen content can cast a shadow into the view.
- Effects from the blurred alpha: shadow (offset and tint, below the layer), glow (no offset), inner shadow and inner glow (inverted alpha, masked by the alpha), outline (threshold of the blurred alpha), bevel (normals from the alpha gradient, then lighting).
- Cache: keep the result for each FX layer for the current view.
- Canvas 2D fallback: `ctx.filter` with `blur()` and `drop-shadow()`.

## 6. Blur and sharpen brushes (L, after 5)

- The brush paints a "blur amount" field for a layer, with strokes, like a mask.
- Render: with the item 5 method, make a pyramid of blurred levels. Each pixel mixes between the levels by its blur amount. This is a variable-radius blur that stays independent of resolution.
- Sharpen: an unsharp mask, `original + k * (original - blurred)`.

## 7. Liquify and warp (XL)

- Data: warp dabs record a direction and a strength. Together they make a displacement field in world units, stored as strokes.
- Render: render the displacement into its own tiles, then sample the layer at the moved positions. The tile margin must be as large as the largest displacement.
- Hard parts: large displacements reach far outside the view, displacements add up, and restore and freeze brushes interact with them.

## 8. Smudge and destructive filters (XL)

These tools read the pixels that are already there, so they need raster patches:

- At the end of a stroke, the client renders the area at the zoom of the stroke, and computes the result.
- It sends `patch.add` with the layer, the bounds, the scale, the image, and a coverage mask. The final pixel is a mix of the existing pixel and the patch, by the coverage.
- The client uploads a patch through HTTP. The op log refers to it by its content hash, because a WebSocket message has a limit of 4 MB.
- Trade-offs: a patch shows pixels when you zoom in far. A stroke that is erased later stays visible in the patch. Storage grows fast.

## Decisions for all items (before item 3)

- Canvas 2D fallback: from item 5, the 2D renderer draws without the effect and shows a "needs WebGL2" badge.
- Version gating: the Tauri apps (Windows, macOS) bundle their client, so they can be old. The server sends the document features. A client that does not know a feature asks for an update.
- File version: `.bdraw` goes to version 2 with masks.
- Frame budget: a cache of each composited layer for the current view keeps live strokes cheap when FX layers or adjustment layers are present.
