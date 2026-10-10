# Multiplayer Canvas — Technical Spec

Version 0.3, 2026-10-03. Target host: `draw.bsums.xyz`.

## 1. Goal

The app is an infinite drawing canvas in the browser. Many people can paint in one session at the same time. A person joins a session with a share code or a share link. Without an account, a canvas is temporary. An account keeps canvases and controls who can open them.

## 2. Scope of v1

In scope:

- Infinite canvas with pan and deep zoom (1e-9× to 1e11×)
- Brush and eraser with size, opacity, flow, hardness, and spacing
- Pen pressure for size and flow
- Airbrush build-up: paint builds up while the pen stays still
- Color picker (HSV square, hue strip, hex field) and eyedropper
- Shared layers: add, delete, rename, reorder, hide, opacity, blend mode
- Undo and redo for each user
- Live view of the strokes and cursors of other users
- Sessions that stay after a server restart
- Export of the current view as PNG
- Save a canvas to a `.bdraw` file, and open a `.bdraw` file as a new canvas, online or on this device (section 9.2)
- Canvases on this device: drawn with no server and no connection, put online later to share them (section 9.9)
- Sessions with a random code or with a name that a person selects
- Phone and tablet use: touch gestures and a phone layout
- Installation as a Progressive Web App (PWA)
- Accounts with email verification, temporary canvases, claiming, and sharing with roles (section 8.1)

Out of scope for v1: selections, transforms, text, shapes, fill, PSD export, sign-in with other providers (section 11).

## 3. Architecture

```
Browser                                              Server (Node, pm2)
┌──────────────────────────────────────────┐        ┌──────────────────────┐
│ Svelte UI (panels, tools, options bar)   │        │ HTTP: static + API   │
│        │                                 │        │ WebSocket: /ws       │
│ Engine ── Net (WebSocket) ───────────────┼───────▶│ Session (in memory)  │
│   │  └─ Doc (confirmed + pending ops)    │◀───────┼─ op log, broadcast   │
│   │                                      │        │        │             │
│ Compositor (main thread, 2D canvas)      │        │ SQLite (WAL)         │
│   ▲ tiles (ImageBitmap)   │ view, ops    │        └──────────────────────┘
│ Tile worker (OffscreenCanvas)  ◀─────────┘
└──────────────────────────────────────────┘
```

Three rules drive the design:

1. The vector op log is the source of truth. A raster is only a cache, and the client can rebuild it at any zoom.
2. The tile worker does all rasterization of committed strokes. The main thread never blocks on it.
3. The main thread draws the stroke in progress at once, with the same brush code as the worker. Thus the stroke feels immediate, and the handoff to tiles gives the same result.

## 4. Document model

A document is a set of layers and a set of strokes. The server gives each accepted op a sequence number (`seq`). The `seq` sets one total order for all clients.

```ts
Layer  { id, name, order: number, blend: BlendMode | 'pass', opacity: 0..1, visible, deleted,
         kind?: 'paint' | 'adjust' | 'group' | 'shape', parent?: groupId | null,
         adjust?: Adjust, clip?: boolean, mask?: { id, enabled } | null }
Stroke { id, layerId, seq, author, brush: Brush, pts: number[], deleted, mask?: maskId }
Shape  { id, layerId, kind: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line', seq, author, deleted?,
         name, z: number, w, h, m: Affine,
         radii?: [tl, tr, br, bl], radiiLinked?, sides?, points?, innerRatio?, rounding?,
         line?: [x0, y0, x1, y1],
         fill: '#rrggbb' | null, stroke: '#rrggbb' | null, strokeWidth,
         align: 'center' | 'inside' | 'outside', cap: 'butt' | 'round' | 'square',
         join: 'miter' | 'round' | 'bevel' }
Brush  { tool: 'paint' | 'erase', color: '#rrggbb', size, opacity, flow,
         hardness, spacing, pressureSize, pressureFlow, buildup,
         tip?, angle?, roundness?, followDirection?, sizeJitter?, angleJitter?,
         scatter?, opacityJitter?, grain?, grainScale?, grainStrength? }
```

All fields with `?` are optional. Older documents have none of them and stay valid without a migration.

- **Adjustment layer** (`kind: 'adjust'`): it has no paint. It changes the composite of everything below it. `Adjust` is levels, curves (2 to 16 points), hue/saturation, or brightness/contrast. The server refuses a plain stroke on an adjustment layer. A mask stroke is permitted.
- **Clipping mask** (`clip: true`): the layer shows only where the nearest layer below it that is not clipped (the base) has alpha. The base and its clipped layers are a clipping group.
- **Group** (`kind: 'group'`), as in Photoshop: a folder of layers. A layer's `parent` names its group (absent or null: the top level), and `order` sorts the layers of one parent. Groups nest up to 8 levels (`LIMITS.maxGroupDepth`; layers may sit inside the 8th). A group has no paint. Its blend is "pass through" (`'pass'`, the default, for groups only): its layers blend with what is below the group, as if they were not grouped, and with opacity under 100% the result is mixed with the backdrop by the opacity. Any other blend makes the group isolated: its layers composite on their own (adjustment layers inside change only the group), then the result blends as one layer. Hiding a group hides its layers. Deleting a group deletes its layers with it (they count as deleted while the group is), and restoring it brings them back unchanged. Clipping works among the layers of one group; a group can be a clipping base. The server checks that the parent is a live group, that a group never goes into itself, and the depth. Rules: `src/shared/layers.ts`.
- **Shape layer** (`kind: 'shape'`): a layer that holds many vector shapes (section 4.1). Each shape has its own fill and stroke, as in Illustrator. Opacity, blend, mask, clipping, groups, visibility, transform and duplicate work as on a paint layer. The server refuses a plain stroke on a shape layer. A mask stroke is permitted.
- **Layer mask** (`mask`): strokes with `mask: <mask id>` on the layer. They paint grey on an implied white mask: black hides the layer, white shows it, and the eraser goes back to white. A new mask gets a new id. Thus the strokes of a deleted mask stay out of a later mask, and undo of the delete brings them back. `enabled: false` turns the mask off and keeps it.

- `pts` is a flat array of `x, y, pressure` triples in world units. One world unit is one CSS pixel at 100% zoom.
- `brush.size` is in world units. The client sets it from the brush size in screen pixels, divided by the zoom at the start of the stroke. Thus a 24 px brush draws a 24 px line at any zoom.
- The client rounds each point to about 0.1 device pixel at the zoom of the stroke. The precision follows the zoom, so a stroke at 1e6× keeps its detail.
- `order` is a fractional index. A move sets `order` to the midpoint of the two neighbor layers. Thus a reorder is one property write, and two users can reorder at the same time without a conflict.
- Delete is a tombstone (`deleted: true`). A tombstone makes undo of a delete possible.
- A stroke keeps the `seq` of its creation. If a user restores a stroke, it goes back to its original position in the z-order.
- **Transform** (`layer.transform`, with an affine matrix `m = [a, b, c, d, e, f]`): changes the points of every stroke of a layer, or of a group and everything in it (masks too, and deleted strokes, so undoing a delete puts them back in the new place). The brush size scales by √|det m| (the average scale), and a fixed tip angle turns with the rotation. Strokes stay vectors, so a transformed layer stays sharp at any scale. A non-uniform scale or a skew keeps the tip shape. The server refuses a matrix that is not invertible, and a transform that would move a point past `maxCoord`. Undo is the inverse matrix.
- **Duplicate** (`layer.duplicate`, with the source `id`, a `newId`, the name, the order and the parent): copies a layer, or a group with everything in it, in one op. The copies' ids come from `derivedId(newId, original id)` (three FNV-1a hashes, base 62), so the server and every client make the same copy. Copied strokes keep their `seq` and author. Undo deletes the copy.

### 4.1 Shapes

A shape is a record in the document, as a stroke is. Rules: `src/shared/shapes.ts` (outline, bounds, hit test) and `src/shared/validate.ts` (`validateShapeInput`).

- **Geometry:** a frame from (0, 0) to (`w`, `h`) in local units, and an affine matrix `m` that maps local units to world units. A move, a rotation and a layer transform change `m` only. Thus they stay exact. A resize with a handle of the Select tool changes the frame, and `m` keeps its rotation.
- **Live settings:** the settings stay editable until point editing changes the shape into a path.
  - `rect`: `radii`, four corner radii (top left, top right, bottom right, bottom left). `radiiLinked` tells the editor to change all four together. When two radii are too large for a side, all four become smaller by the same factor, as in CSS.
  - `ellipse`: `arc`, the start and end angle of a pie slice in degrees (-360 to 360), and `hole`, an inner ellipse cut out (0 to 0.99 of the size). The angles are on the circle before the frame stretches it: 0 is right, and 90 is down (clockwise on screen). The slice goes clockwise from the start to the end. A whole turn (the same angle twice) is the whole ellipse. With a hole, an ellipse is a ring, and a slice is a slice of the ring. Without an arc or a hole, the server leaves them out.
  - `custom`: `preset`, one of 12 ready-made outlines (`CUSTOM_SHAPES`): heart, bubble, arrow, cloud, check, bolt, moon, drop, plus, banner, burst, frame. Each is a Bezier path in a box of 100 × 100 (`CUSTOM_PATHS` in `src/shared/shapes.ts`), stretched to the frame. Add new presets at the end, and never remove one: old documents use them.
  - `polygon`: `sides`, 3 to 64. `star`: `points`, 3 to 64, and `innerRatio`, the inner radius as a fraction of the outer radius (0.01 to 1). The points of a polygon or a star are scaled to fill the frame.
  - `polygon` and `star`: `rounding`, a corner radius. Each corner gets at most the radius that fits half of its shorter edge.
  - `line`: `line`, the start and the end point in local units. The frame is the box of the two points.
  - `path`: `path`, one or more Bezier contours. A contour has `closed` and `pts`: 7 numbers for each point, the anchor (x, y), the handle toward the previous point (ix, iy), the handle toward the next point (ox, oy), and the type (0 corner, 1 smooth, 2 symmetric). A handle at its anchor is no handle. A segment without handles is straight. The frame is the box of the curves (with their extremes), and it fits the curves again after each change. A path fills an open contour as if it were closed, and an open contour always has a center stroke. At most 100 contours and 5000 points (`LIMITS.maxContours`, `LIMITS.maxPathPoints`).
  - `path` with `curve: 'spline'`: the contours are x-splines (Blanc and Schlick) through or near the anchors, without handles. The handles repeat the anchor, and the 7th number of each point is its smoothness, from -1 to 1. At -1, the curve goes through the point and is round (Catmull-Rom). At 0, the point is a sharp corner. At 1, the curve bends toward the point but does not touch it (a B-spline). The two ends of an open contour are always sharp. Without `curve`, or with `curve: 'bezier'`, the type is a whole number from 0 to 2. A change of the curve type converts the points: a Bezier path becomes a spline with the anchors as its points (a corner without handles stays a corner, and a point with handles goes through), and a spline becomes Bezier curves that fit it within 0.2% of each segment length.
  - `compound`: `parts`, 1 to 64 shapes combined live (`LIMITS.maxParts`). A part has the geometry of a shape of any kind except a line or a compound (`kind`, `w`, `h`, the settings of its kind, an optional `name`), a matrix `m` from its own units to the compound's local units, and an `op`: `unite`, `subtract`, `intersect` or `exclude`. The result starts as the first part (its op has no effect). Then each next part changes the result by its op: unite adds its area, subtract removes it, intersect keeps only the area in both, and exclude keeps the area in one but not both. Each part fills by the nonzero rule. The compound has the style, and its frame is the box of its parts. The path points of all parts together count toward the 5000 point limit.
- **Lengths:** the radii, `rounding` and `strokeWidth` are local units. Thus a layer transform scales them with the shape, and a skew skews the stroke too. The editor shows them in screen pixels at the current zoom, as the brush size.
- **Style:** `fill` and `stroke` are a color or null (none). A line has no fill. `align` puts the stroke on the center of the outline, inside it, or outside it. A line always has a center stroke. `cap` is for the ends of a line and of each dash. `join` is for corners (the editor uses miter, with a miter limit of 4).
- **Dashes:** `dash`, a pattern of at most 8 lengths in stroke widths: dash, gap, dash, gap (an odd count repeats, as in SVG). Thus the dashes scale with the stroke. A dash of length 0 with round caps is a dot. The pattern starts again at the start of each contour. An empty pattern, or all zeros, is a solid stroke, and the server leaves it out. A compound shape draws a solid stroke.
- **Arrowheads:** `arrows`, what the start and the end of a line, or of each open contour of a path, show: `none`, `arrow` (a filled triangle), `open` (a V of two strokes), `circle` (a filled dot) or `bar` (a stroke across the end). An arrow is 4 stroke widths long and 4 wide, and the other heads are about that size. Heads have the stroke color. It points from the point one head length back along the curve to the end. A filled arrow stops the line 2 stroke widths before its tip, so the line end and its cap stay under the head. ["none", "none"] is no arrows, and the server leaves it out.
- **Order:** `z` is a fractional index among the shapes of a layer, as `order` is among layers.
- **Ops:** `shape.add` (the whole shape), `shape.update` (some props, and the kind), `shape.remove` and `shape.restore` (a tombstone, as for strokes). The server merges an update with the shape and checks the result as a whole shape of its kind. Settings of another kind are dropped. Thus point editing changes a rectangle into a path in one update, and undo changes it back with its radii. The server refuses a frame corner past `maxCoord`, and more than 20000 live shapes on a canvas (`LIMITS.maxShapes`).
- **Layer ops:** `layer.transform` multiplies the matrix of each shape of the layers (also deleted shapes) by the transform. `layer.duplicate` copies the shapes, with ids from `derivedId`.
- **Feature flags:** a document with a shape layer lists `shapes` in `welcome.features`, a document with a path lists `paths`, a document with a spline path lists `splines`, a document with a compound shape lists `compounds`, a document with an ellipse arc or hole lists `arcs`, a document with a custom shape lists `custom`, a document with a dash pattern lists `dashes`, a document with arrowheads lists `arrows`, and a document with a vector stroke lists `vectors` (section 4.2). The settings of a part of a compound, or of a vector stroke, count too. A client from before them then asks for an update. It does not draw the canvas wrong.

### 4.2 Shapes made paint (vector strokes)

A shape can become paint, so that the brush and the erasers work on it (`src/shared/flatten.ts`).

- **Vector stroke:** a stroke with `vector`, the geometry and style of a shape (without id, layer, name and order). It draws as the shape did, exact at any zoom, in the stroke order of its paint layer. An erase stroke on top cuts it, as it cuts any paint. `pts` hold its frame corners (for the bounds, layer transforms and the stroke eraser). A layer transform also multiplies its matrix.
- **`shapes.toPaint`** (`key`, `ids`, `layerId`): each shape becomes a vector stroke with the id `derivedId(key, shape id)`, in drawing order, and the shape is removed. The target is a paint layer, or the shapes' own shape layer when the op holds all its shapes: that layer then becomes a paint layer in place, and its mask, clipping, opacity and place stay.
- **`shapes.fromPaint`** (the same fields): the undo. The strokes go and the shapes come back. A layer that became paint becomes a shape layer again, but not while it holds other paint (the server refuses).
- One op converts any number of shapes, so a big layer does not hit the op rate limit. The server and every client plan the op with the same function, so they make the same strokes.

## 5. Brush model

A stroke is a sequence of dabs. A dab is one stamp of the brush tip.

| Parameter | Range | Effect |
|---|---|---|
| size | 1–1000 px | Diameter of the dab in screen pixels at the zoom of the stroke |
| opacity | 0–1 | Maximum alpha of the full stroke |
| flow | 0–1 | Alpha of one dab. Overlapping dabs build up toward `opacity` |
| hardness | 0–1 | Size of the solid core. 0 gives a soft falloff, 1 gives a hard edge |
| spacing | 0.01–2 | Distance between dabs as a fraction of the diameter |
| pressureSize, pressureFlow | on/off | Pen pressure scales the size or the flow |
| buildup | on/off | Airbrush mode. A pen that stays still keeps adding dabs |

Render steps for one stroke:

1. Walk the polyline. Put a dab each time the walked distance reaches `spacing × diameter`.
2. Draw each dab into an empty stroke buffer with alpha `flow`, source-over.
3. Composite the stroke buffer onto the layer with alpha `opacity`. A paint stroke uses source-over. An erase stroke uses destination-out.

This gives the Photoshop split between opacity and flow. Flow builds up inside a stroke. Opacity caps the stroke.

The round tip is a radial stamp. The alpha is 1 inside `hardness × radius`, then a cosine falloff goes to 0 at the radius. The outer edge has one pixel of antialiasing. A cache keeps stamps by color, hardness, and size bucket (power of two).

Other tips (square, chalk, charcoal, bristle, splatter, pencil) and the grains (paper, canvas, noise) come from code in `src/client/engine/tips.ts`, with no image files. Thus both renderers get the same pixels. Each tip lies inside the unit circle, so a rotated dab never grows past its radius. A tip or grain id never changes after a release: a new look gets a new id.

| Parameter | Range | Effect |
|---|---|---|
| tip | id | Shape of the dab. Hardness applies to `round` only |
| angle | 0–360° | Rotation of the tip |
| roundness | 5–100% | Squashes the tip along its height |
| followDirection | on/off | Adds the stroke direction to the angle |
| sizeJitter, opacityJitter | 0–1 | Random reduction of the size or the flow of each dab |
| angleJitter | 0–1 | Random turn of each dab, as a fraction of 360° |
| scatter | 0–4 | Random offset across the stroke, in diameters |
| grain, grainScale, grainStrength | id, 0.1–10, 0–1 | Paper texture in stroke space: the grain origin is the first point, and one grain tile is `grainScale` diameters. Thus the grain stays the same at any zoom |

Determinism: the random values come from a stateless hash of the stroke seed (from the stroke id) and the dab index. Thus every tile, every client, and every replay get the same jitter. The dab positions along the path do not depend on the random values. The client sends only the fields that differ from the default, so a plain stroke stays as small as before.

For airbrush build-up, the client adds a point at the same position every 30 ms while the pen stays still. When `buildup` is on, a zero-length segment gives one dab. The points carry the build-up, so a replay gives the same result.

The dab walker is one shared module (`src/shared/brush.ts`). The worker and the main thread use the same module. Thus the same points always give the same dabs.

## 6. Rendering pipeline

The client has two renderers with one interface (`src/client/engine/renderer.ts`):

| Renderer | Used when | Buffers | Blend modes |
|---|---|---|---|
| WebGL2 (`gl/glRenderer.ts`) | WebGL2 is available | RGBA16F (half float). RGBA8 if the GPU cannot render to float. | Shader, W3C formulas |
| Canvas 2D (`compositor.ts` + tile worker) | No WebGL2 | RGBA8 | Canvas 2D composite operations |

`?renderer=2d` in the URL forces the Canvas 2D renderer, for comparison. The status bar shows the renderer and its bits per channel. Both renderers use the same dab walker and the same stroke index (`strokeIndex.ts`), so they give the same image. Only the precision is different: with 100 overlapping dabs at 1% flow, the WebGL2 result is within 1 level of the exact value, and the 8-bit result is 8 levels off.

Resize: a change of the canvas size clears the canvas. The engine draws the next frame at once, in its ResizeObserver callback (`renderNow`), before the browser paints. Thus a window resize never shows a black canvas. Frames drawn this way do not count for the frame-speed measures.

### 6.1 Tiles and level of detail

- A tile is 256 × 256 device pixels for one layer.
- The level of detail (LOD) is an integer. A tile at LOD `L` covers `256 × 2^L` world units.
- The client selects `L` from the device scale (zoom × devicePixelRatio). The range is −45 to 40. Negative `L` gives sharp tiles at high zoom. This is the benefit of vector storage.
- If a full stroke is smaller than 2 pixels at a tile's LOD, the renderer draws it as one dot. Thus a far zoomed-out view stays fast.
- The tile key is `layerId | L | tx | ty`.

### 6.2 WebGL2 renderer

- **Dabs:** instanced draw calls. Each dab carries its own color and hardness, so a run of strokes that draw the same way (full opacity, no grain, the same tool, tip and roundness) shares one call in a tile. A tile that hundreds of strokes cross took hundreds of calls, and on a phone the cost of each call set the speed. The dabs keep their order, so the pixels do not change (tested: batched and one call per stroke give identical images). A stroke below full opacity or with grain still has its own call. The CPU computes each dab position relative to the target in double precision and sends small float32 numbers to the GPU. Thus deep zoom stays exact. A dab with a radius over 10^6 px draws on a quad that covers only the tile. The CPU works in dab space: the tile offset rotated by the negative tip angle, with the height divided by the roundness. There the dab is a circle. In double precision, the CPU computes the tile center relative to the dab center (v), the distance |v| minus the radius, and 1 / (|v| + radius). The shader gets the edge distance of each pixel from these small numbers, and no two huge numbers cancel. Thus the edge is exact at any zoom, on all sides of an elliptical dab, and deep inside a dab. Textured tips use the true center. Before, a stand-in circle of radius 10^6 px near the edge was exact only on the axes of an elliptical dab. Its curvature also put kinks at tile edges. Now the edge is less than 1 px from the Canvas 2D edge. Tested: roundness 0.3 and 0.05, zoom 10^3 to 10^11. The CPU also computes the cosine and the sine of the tip angle for each dab. On the GPU, float32 sin and cos can be wrong by 10^-5 rad or more. Then an edge 10^6 px from the dab center moved by tens of pixels (34 px at 290° in SwiftShader). The Canvas 2D renderer draws huge dabs from their exact shape (6.3). The fragment shader uses the same profile as the Canvas 2D stamp: a solid core, a cosine falloff, and one pixel of edge antialiasing.
- **Tiles:** each tile is a float texture. The renderer updates tiles on the main thread, from the center of the view out. A new stroke on top of a tile draws over the existing pixels. A removed or restored stroke makes the tile render again. A stale tile stays on screen until the new one is ready.
- **Tile budget:** each frame gets two limits for tile work: JavaScript time, and a GPU fill budget (the estimated dab area in device pixels, plus a cost per draw call). JavaScript time does not show GPU cost. On a phone, too much queued GPU work blocks the whole page until it drains. There are two fill budgets. While the view moves (150 ms after a pan or zoom) or this device draws a stroke, the budget aims at 20 ms frames, with 6 ms of JavaScript. While everything is still, it aims at 40 ms frames, with 12 ms of JavaScript: tiles finish sooner, and nothing moves that could stutter. Each budget follows its frame interval: 15% over the aim cuts it by 25%, 15% under raises it by 10%. Before, one budget aimed at 22 ms always: a GPU that cannot reach 60 fps even without tiles held it at the minimum, and a phone took minutes to draw a canvas.
- **Prefetch:** the renderer keeps tiles current for the view plus a ring of one tile. When those are done, it also renders one level coarser over 2× the view, and two levels coarser over 4× the view. After a zoom out by up to 4×, or a pan, the screen shows stretched content at once instead of blank tiles. Each level costs about one view of tiles. The renderer skips these levels when the tiles would go over 400 (touch screens) or 1200 (other devices). It never frees a tile in these ranges.
- **Split renders:** a full tile render can span frames. The strokes draw into a new texture, a few in each frame, and the new texture replaces the old one when all strokes are drawn. A stroke added to or removed from that area starts the render again.
- **Strokes in progress:** each one has a screen-size float buffer. New dabs draw into it as points arrive. After a pan or zoom, the buffer draws again from its dabs.
- **Dab shader:** each dab instance has a rotation. The fragment shader applies the rotation and the roundness, then uses the analytic round profile or samples the tip from a texture array with mipmaps (the GPU selects the mip level from the dab size). Grain multiplies the alpha with a tileable texture. The CPU reduces the grain origin modulo one grain tile, so the numbers stay small at any zoom.
- **Compositing:** the layers stack in a float buffer that starts with the paper color. A normal layer without a stroke in progress or a mask goes straight onto the stack with hardware blending. Other layers go into a layer buffer first, and a blend shader combines that buffer with the stack (two buffers in turn). The blend shader uses the W3C Compositing and Blending formulas, which include hue, saturation, color, and luminosity.
- **Layer masks:** mask strokes have their own tile set (key `<layer>#<mask id>`). The renderer draws the mask tiles and mask strokes in progress into a mask buffer. A shader turns the grey into visibility `v = grey + (1 − alpha)` and multiplies the layer buffer by `v`.
- **Clipping groups:** the base draws into a group buffer. Each clipped layer then draws with its blend mode, but only where the base has alpha (source-atop: the group alpha does not change). The group then goes onto the stack with the blend mode and opacity of the base.
- **Adjustment layers:** one full-screen pass reads the stack and writes the adjusted result, mixed by the layer opacity and the mask visibility. Levels, curves, and brightness/contrast use a 1024-entry tone lookup texture (`src/client/engine/adjust.ts`). Hue/saturation uses HSL math in the shader. Inside a clipping group, an adjustment layer changes only the group.
- The mask and group buffers are made at the first frame that needs them.
- **Output:** the stack goes to the 8-bit canvas with a small triangular dither, so gradients do not show bands.
- **Context loss:** a phone or a PWA in the background can lose the GPU context. The renderer then makes all GPU resources again and renders the tiles again.
- **Performance profiles** (`perf.ts`): how much work a device gets.

  | Profile | Used on | Canvas pixel ratio | Buffers | Tiles kept (soft, hard limit) | Coarser levels |
  |---|---|---|---|---|---|
  | full | mouse or pen as the primary pointer | the screen's own | RGBA16F | 512, 1200 | 2 |
  | phone | touch screens | at most 2 | RGBA16F | 160, 320 | 2 |
  | light | touch screens with at most 3 GB memory or 4 cores, an older GPU (Adreno 2xx to 5xx, Mali-4xx, Mali-T, Mali-G31 to G57, PowerVR), or a device that was too slow before | at most 1.5 | RGBA8 | 128, 256 | 1 |

  The CSS layout keeps the screen's own pixel ratio; only the canvas renders fewer pixels. When panning and zooming run under 30 fps (median frame over 34 ms in 60 frames while the view moves), the engine lowers the canvas pixel ratio one step (2, 1.5, 1.25, 1) and remembers the device as slow (`localStorage` `draw.perf.slow`): the next start uses the light profile. `?perf=full|phone|light` or `localStorage` `draw.perf` forces a profile. Exports and link previews always render with the full profile. The status bar shows the profile on touch devices. For checks: `__draw.engine.comp.stats()` in the console (tiles, pending work, budgets, scale, bits).

### 6.3 Canvas 2D renderer (fallback)

A worker holds a copy of all confirmed strokes and renders tiles with OffscreenCanvas. It sends each tile to the main thread as an `ImageBitmap` with zero-copy transfer. The main thread composites the tiles with Canvas 2D blend modes. Strokes in progress draw on the main thread with the same brush code.

The fallback draws tips, rotation, roundness, and jitter, but not grain. It applies layer masks and adjustment layers on the CPU (`getImageData`), with the same formulas as the shaders. A clipped layer uses `source-atop`, so its blend mode is not applied (Canvas 2D has no blend mode with atop).

Dabs come from stamp bitmaps (a power of two, at most 1024 px). A dab with a diameter over 8192 px on the target does not use a stamp. A stamp pixel would then cover thousands of target pixels, and the float32 transform of the canvas loses the dab position (before, a round edge showed as a wide gray blur, and a rotated or squashed dab went gray at ×10^3 and vanished at ×10^6). The renderer does all the math for these dabs in double precision, in the dab space (rotated by the tip angle, with y divided by the roundness), relative to the target. Only small numbers go to the canvas (`DabPainter.hugeRound`, `hugeTip` in `stamp.ts`):

- **Round tip, constant falloff or hard edge:** the outline is the part of the dab over the target, as a polygon. Its vertices lie on the true edge (chords within 0.01 px), and the canvas antialiases it. Where the hardness falloff changes by less than 1/1024 over the target, the fill is one solid alpha.
- **Round tip, wide falloff** (at least 64 px at its narrowest): the alpha is sampled on a grid of at most 16 px, and the canvas filter fills in between. The falloff ends at 0 with no slope, so it needs no outline. The error stays below half a level.
- **Round tip, thin falloff:** the outline polygon is filled with a radial gradient. The float32 error of the gradient is relative to the radius, as the width of the falloff is.
- **Textured tip, texel up to 1024 px:** the renderer draws only the texels over the target, plus one texel of margin for the filter, with a transform whose offset stays near the target.
- **Textured tip, larger texel:** the renderer samples the tip on a grid along the tip axes (bilinear, as the WebGL texture). The grid step is at most 16 px and at most 1/64 of a texel.

Tests in headless Chromium with SwiftShader compare 2D and WebGL2 screenshots on round, elliptical, soft, and textured dabs at zooms from ×0.5 to ×10^11. The difference is at most 2 levels, except on the 1 px antialiased edge. There WebGL2 puts the 50% point 0.5 px outside the true edge.

### 6.4 Shapes

- A shape layer has tiles, as a paint layer has. To render a tile, the renderer draws the shapes that touch it, bottom to top, with Canvas 2D paths on an OffscreenCanvas of 256 × 256 pixels. The WebGL2 renderer then copies the canvas into the tile texture. The tile worker of the Canvas 2D renderer does the same in the worker (`src/client/engine/shapeRaster.ts`).
- Deep zoom: the renderer builds the matrix from local units to tile pixels in double precision, and subtracts the tile origin first, as `putDab` does. If the whole shape is less than 32768 pixels from the tile, Canvas draws the path through that matrix. Else the renderer makes the outline and the stroke as polygons in double precision, and cuts them to the tile. An arc becomes short chords only near the tile, where an edge of the outline or of the stroke band can cross it. Thus a shape stays sharp at 10^11×, with a few dozen points for each tile.
- Stroke alignment: an inside stroke draws twice the width, clipped to the outline. An outside stroke draws twice the width under the fill. Without a fill, an outside stroke is clipped to everything outside the outline.
- Curves: a cubic segment splits in two (de Casteljau) until its control points are within the tolerance of the chord, or until no edge of the outline or of the stroke band can cross the tile. A piece that turns more than 90° always splits.
- Splines: each segment flattens at three or more levels of subdivision, and more while the curve is farther than the tolerance from its chords.
- Dashes (`src/shared/strokeStyle.ts`): the renderer measures the dashes along the true curve, in local units, and never along flattened points. Thus every tile cuts the same dashes, and they meet at tile edges at any zoom. Each segment splits in halves by its parameter until a piece holds a few dash ends, and the renderer skips the pieces far from the tile. A piece's offset is its parent's offset plus the length of its left sibling, so a piece has the same offset in every tile. Lengths come from adaptive Gauss-Legendre sums. A dash is an exact part of its segment (a part of a cubic, an arc or an x-spline), and it strokes as an open contour with caps. When one period of the pattern is less than 1.5 pixels on the target, or a tile would hold more than 20000 dashes, the stroke draws solid.
- Arrowheads: polygons in tile pixels, built in double precision and cut to the tile, filled in the stroke color after the stroke.
- Compound shapes: the fill is a mask on a scratch canvas of the tile size. The first part fills it, and each next part changes it by a Canvas composite operation: `source-over` (unite), `destination-out` (subtract), `destination-in` (intersect) and `xor` (exclude). The fill color is then cut to the mask. The stroke follows the true outline of the result (`src/shared/boolean.ts`). Every edge of every part is cut where it crosses an edge of another part, and a piece of an edge is outline when the result differs on its two sides. The pieces join end to end, with the result on their left. The stroke is built from them in double precision, as for other shapes, so it stays exact at deep zoom. The parts are cut to a box around the tile, and the sides of that box are not outline.
- Vector strokes draw with the same code, on the tile in their stroke order (the tile worker draws them on its tile canvas).
- Edits: while a shape changes (a drag, a slider), the change is a draft. A layer with drafts draws straight to the screen each frame, from all its shapes, in place of its tiles. When the drafts end, this continues until the tiles of the layer in view are current. Thus a drag shows at once, and the layer does not flash back.
- Far zoom-out is not optimized yet: each tile draws every shape that touches it.

### 6.5 Strokes in progress and the handoff

- The local stroke draws at once. The input uses `getCoalescedEvents()` for full pen rate.
- Remote strokes in progress arrive as `live` messages every 40 ms. Each one draws into its own buffer.
- At pointer up, the client sends `stroke.add`. The buffer stays on screen until the tiles show the stroke. Then the client removes the buffer.

## 7. Sync protocol

Document features: `welcome.features` lists the newer features the document uses (`adjust`, `clip`, `mask`, `tips`, `groups`, `shapes`, `paths`, `vectors`, `splines`, `compounds`, `arcs`, `custom`, `dashes`, `arrows`, from `src/shared/features.ts`). A client that does not know a feature shows "This canvas uses features from a newer Draw" and does not draw the canvas silently wrong. A `live` message for a stroke on a mask carries `mask`.

Transport: JSON over WebSocket at `/ws?code=XXXX-XXXX`, with permessage-deflate.

| Direction | Message | Persisted | Purpose |
|---|---|---|---|
| C→S | `hello` | — | Display name, anonymous secret, desktop token, link token, join password or grant |
| S→C | `welcome` | — | Client id, peers, full document, current `seq`, role, canvas info, grant |
| S→C | `access` | — | The role or the canvas info changed (claim, sharing change) |
| S→C | `denied` | — | No access, password needed or wrong, expired, deleted |
| C→S | `op` | yes | One document op (table below) |
| S→C | `op` | — | The op with its `seq` and author, to all clients |
| C→S→C | `live` | no | Points of a stroke in progress |
| C→S→C | `shape.live` | no | Shapes as a person changes them (at most every 40 ms). An empty list ends the drafts. |
| C→S→C | `cursor` | no | Cursor position and active layer (max 20/s) |
| S→C | `peer.join`, `peer.leave` | — | Presence |
| S→C | `error` | — | Rejected op, with a reason code |

Ops: `stroke.add`, `stroke.remove`, `stroke.restore`, `layer.add`, `layer.update` (any of name, blend, opacity, visible, order), `layer.remove`, `layer.restore`, `layer.transform`, `layer.duplicate`, `shape.add`, `shape.update`, `shape.remove`, `shape.restore`, `shapes.toPaint`, `shapes.fromPaint`.

Consistency:

- The server is the sequencer. Each client applies ops in `seq` order, so all clients converge.
- The client keeps two states: the confirmed state (ops from the server) and a list of its own pending ops. The UI shows the confirmed state with the pending ops on top. When the echo of a pending op arrives, the client removes it from the pending list.
- Concurrent `layer.update` writes use last-writer-wins by `seq`, one property at a time.
- Strokes do not conflict. Each stroke is its own object.

Undo and redo are local to each user. Each user has a stack of their own actions. Undo sends the inverse op: `stroke.remove` for a stroke, `layer.update` with the old values for a property change, `layer.restore` for a layer delete, `shape.update` with the old values for a shape change, `shape.remove` for a new shape (and `layer.remove` for the shape layer that it made).

## 8. Server

- Node 20 or later, `ws`, `better-sqlite3`, no framework.
- `POST /api/sessions` makes a session and gives back its code. `GET /api/sessions/:code` tells if a session exists.
- All other paths give the static client. `/s/:code` gives `index.html`.
- A session key is a code or a name:
  - A code has 8 characters from a 31-character set with no look-alike characters (format `XXXX-XXXX`, about 8 × 10^11 codes). The code is the only access control. Thus it must be hard to guess.
  - A name has 3 to 40 lowercase letters, digits, and single dashes (`friday-jam`). The server makes a name from the input ("Friday Jam!" becomes `friday-jam`). A name in code format is not permitted. A name is easy to guess, so the UI tells the user that anyone who guesses it can join.
- `POST /api/sessions` with `{"name": "..."}` makes a named session. If the name exists, the server sends 409 with the key.
- `GET /api/sessions/:input` accepts a code (with or without the dash) or a name, and gives back the key of the session that exists.
- The server loads a session into memory at the first join. It unloads the session 5 minutes after the last client leaves.

SQLite schema:

```sql
sessions(code TEXT PRIMARY KEY, created_at INTEGER, last_active_at INTEGER, seq INTEGER)
ops(code TEXT, seq INTEGER, client_id TEXT, type TEXT, data TEXT, created_at INTEGER,
    PRIMARY KEY (code, seq))
```

### 8.1 Accounts and access

Accounts:

- Email and password. The server stores the password as a scrypt hash (random salt, N = 2^15).
- Email confirmation is off by default: registering makes a confirmed account and logs in at once (201 with the user, and a cookie or, for the desktop app, a token). An email that already has an account gets 409 `email_taken`. An unconfirmed account left from confirmation mode can be registered again, which takes it over. With `EMAIL_VERIFICATION=1`, a new account must open the confirmation link (valid 48 hours) before it can log in, and the server deletes accounts that stay unconfirmed for 48 hours.
- Captcha: registering and asking for a password reset email need a solved ALTCHA challenge (altcha.org, MIT, self-hosted: `src/server/captcha.ts`). `GET /api/captcha` gives a signed challenge, valid 10 minutes: PBKDF2/SHA-256, 2000 iterations, the secret counter between 1000 and 3000 (`CAPTCHA_COST`, `CAPTCHA_COUNTER_MIN`, `CAPTCHA_COUNTER_MAX`). The browser finds the counter in about a second, in workers; the server checks in under a millisecond. Each solution works once (kept in memory until it expires). The widget loads only with these forms, solves on load, and has its "human interaction signature" collector turned off: no third party, no tracking, no image puzzles. A wrong, used or expired solution gets 400 `captcha`, and the form gets a new challenge after each try.
- Password reset by email (link valid 2 hours, one use). A reset logs out all other sessions.
- The web app uses an httpOnly, Secure, SameSite=Lax session cookie (30 days, sliding). The desktop app uses a bearer token, because its page has another origin.
- Session, email, and device tokens are 256 random bits. The database keeps only their sha256.
- The `identities` table (provider, subject, user) is ready for sign-in through Authentik, Google, GitHub, Discord, or Facebook later.
- Forgot and resend never tell if an email has an account. Register does, when email confirmation is off (409); the captcha and the rate limit slow down guessing. Login runs scrypt also for unknown emails, so its time tells nothing.
- State-changing API calls need a JSON body and an allowed Origin (CSRF protection). Rate limits apply to register, login, email sending, canvas creation, and sharing.

Canvases:

| Kind | Made by | Expires | Who can open it |
|---|---|---|---|
| Temporary | Anyone without an account | 5 days after creation | Anyone with the code (editor) |
| Owned | An account, or a temporary canvas after a claim | Never | The owner, members, link users |
| Legacy | Made before accounts | Never | Anyone with the code. The first login of `ADMIN_EMAILS` adopts it. |

- Only accounts can make named canvases. Thus a name cannot expire and then point to another person's canvas.
- Each browser keeps a random anonymous secret. A temporary canvas stores the sha256 of the creator's secret. Only that browser sees "Log in to keep it", and the claim needs a login.
- On an owned canvas, the owner sets what the canvas link (the plain `/s/CODE`) gives: draw (public), view (the default), or nothing (private). Every link contains the code, thus the code gives edit access only on a public canvas. After an adoption, old links give view access only.
- The claim dialog asks two things. Who can open the link: public (the default, as before the claim), view only, or private. The address: keep the code, a new random code, or a name. A taken name stops the claim before it changes anything.
- The owner can rename a canvas at any time (Share, then Address). The op log, members, and private link tokens move with it. Links with the old address stop working. Connected people who keep their access follow the canvas to the new address; the others are disconnected.
- An hourly job deletes expired temporary canvases. It tells connected people that the canvas expired, then disconnects them.

Roles: owner, editor, viewer. The best of these wins:

1. Owner. Admins (`ADMIN_EMAILS`) count as the owner of every owned canvas: they join any canvas (also a private one, without a link or password) and can do all that the owner can, such as sharing, links, password, rename, transfer and delete. The Share dialog names the real owner and tells an admin that they manage someone else's canvas. Temporary canvases do not change: anyone with the code draws there.
2. Member role. The owner adds a member by the email of a confirmed account.
3. Link role: the best of the token and the canvas link. `?k=` with the private edit token gives editor. `?k=` with the private view token gives viewer. The plain code gives what the owner set for the canvas link. A wrong token gives only what the plain code gives. Link tokens are 128 random bits (22 characters).

The owner can turn each link on or off, or reset it. The owner can also set a join password for link users. Members never need it. After one correct password, the client keeps a signed grant (HMAC of the canvas and the password hash). A new password makes old grants invalid. A change to sharing re-checks all connected clients at once: a lost role disconnects them, and a changed role updates their UI. The server rejects ops from viewers. The owner (or an admin) can transfer ownership (the old owner becomes an editor, also when an admin makes the transfer) or delete the canvas.

At load, the server replays the op log to build the document. Limits: 4 MB per message, 20 000 points per stroke, 100 layers per session, 10 new sessions per minute per IP address. The server checks each op for type, range, and size before it accepts the op.

## 9. User interface

The layout is close to Photoshop, but simpler, with a dark theme.

- Top bar: app name, session code with a copy-link button, peer avatars, connection state
- Options bar: the settings of the current tool (size, opacity, flow, hardness, spacing, pressure, build-up). It floats over the top of the canvas, between the left toolbar and the right panel. When the bar changes height (another tool, a narrow window), the canvas, the toolbar and the panels do not move. In a narrow window, the bar wraps to more rows. It never cuts off a control. The overlays at the top of the canvas (the temporary-canvas banner, the connection message, the edge markers) stay below the bar. A wheel over the bar zooms the canvas.
- Left toolbar, top to bottom: brush (B), eraser (E), stroke eraser (Shift+E), foreground and background colors, eyedropper (I), Transform (Ctrl+T or V; it opens and closes the transform box of the active layer); at the bottom: hand (H) and zoom (Z). Zoom tool: a click zooms in 2× at the point (a short animation), Alt+click or right-click zooms out 2×, a sideways drag zooms smoothly about the press point (right: in); the cursor shows zoom-in or zoom-out. Its options bar has zoom out, zoom in, 100% and Fit all. Two fingers still pinch-zoom with any tool
- Right panels: Color, Layers
- Status bar: zoom, cursor position in world units, stroke count

Finding content on the canvas (`engine/navigator.ts`). A drawing can be off screen, or too small to see at the current zoom. Thus every stroke on a visible layer is in exactly one of three states:

| State | What the user sees |
|---|---|
| On screen, 10 px or larger | The stroke |
| On screen, smaller than 10 px | A pin with a count. Near pins merge. A group that is big and dense on screen reads as a shape and gets no pin. |
| Off screen | One of 8 edge arrows, one for each direction, with a count |

- The visible-shape test uses the true screen area of the strokes. Sub-pixel dust never counts as a shape, so it always keeps a pin.
- If there are more than 20 pins, the grouping grid doubles (48, 96, 192 px, and so on). Thus the view never gets dense.
- A click on a pin or an arrow flies to that content. The pins then split into smaller groups.
- Two round buttons at the bottom right of the canvas turn the markers on and off (also `M`) and fit all content (also `Ctrl+0` or `Home`). Fit all shows the content of all visible layers. `Ctrl+1` goes to 100%. Edge arrows move out of that corner, so they never go under the buttons.
- A fly-to moves the zoom in log space. A long trip zooms out, travels, and then zooms in. Any input stops it.
- The client computes the markers from a cache of stroke bounds, at most every 120 ms. The interval grows with the cost of the last computation (about 30 ms for 20 000 strokes). During a fly-to, the client computes the markers only at the end.

Phone layout (width under 760 px, or a short touch screen): the canvas fills the screen. A bottom bar holds the tools and three buttons that open bottom sheets: brush settings, color, and layers. On a landscape phone, the sheets open as a panel on the right side. A zoom label at the top left resets the zoom to 100%. The top bar puts Open, Save, Export PNG and Leave in a "⋮" menu. The layout works down to a 320 px wide screen.

Popups (the Dynamics and Presets popovers, the account, "⋮" and adjustment-layer menus, and the phone bottom sheets) close when the person presses anywhere outside them, or presses Esc. Android's Back (and a browser's back button) closes the newest popup, dialog or transform box first (`back.ts`): while one is open, a history entry sits on top of the page's own. Before, Back left the canvas for the start page, and coming back loaded the whole canvas again. A press outside on the canvas only closes the popup: a mouse or pen press does not paint, and a finger pans (a second finger pinch-zooms at once). The bottom bar does not close a sheet: its buttons switch sheets. Closing a popup also releases the keyboard from its number fields, so shortcuts work again.

Desktop layout: the right panel (color and layers) scrolls as one when the window is short. Overlays on the canvas, such as the temporary-canvas banner, fit the canvas width and wrap their text.

Sliders: size, flow and spacing use a log scale, with fine steps at the low end. Flow goes from 0.5% to 100%, spacing from 1% to 200%. A percent below 10% shows one decimal. The slider is drawn by the app (not a native range input), with a filled part up to the value. On touch screens the hit area is 44 px high and the thumb 22 px. The track has `touch-action: pan-y`: a vertical swipe scrolls the sheet, a sideways drag moves the value (from the first sideways movement), and a tap sets the value at that point. Mouse and pen set the value at once. Keys: arrows (Shift: 10 times the step), Home, End.

Touch gestures:

| Gesture | Action |
|---|---|
| One finger | Draw. After a pen was used, one finger pans (palm rejection). |
| Two fingers, move | Pan and pinch zoom |
| Two-finger tap | Undo |
| Three-finger tap | Redo |

A second finger within 300 ms of the first cancels the stroke of the first finger. A later finger does not interrupt a stroke.

PWA: the app has a web manifest, icons (also maskable), and a service worker. The service worker caches the app shell. It loads pages from the network first, so a deploy shows at once. It never caches `/api` or `/ws`. Chrome, Edge, and Firefox for Android can install the app. Desktop Firefox has no general PWA install.

The landing page keeps a list of recent sessions in local storage on each device. With an account, it shows a name field (empty: "Random code") and two buttons, "Create private canvas" and "Create public canvas". Without an account, it shows "New canvas" (temporary). In the web app (not the desktop app), a "Download app" button opens the latest GitHub release.

### 8.9 Stroke eraser

A tool (Shift+E; after the eraser in the toolbars) that removes whole strokes, as vectors allow, instead of painting transparency.

- A circle with a size in screen pixels (2 to 400, log scale). Every stroke whose path (its center line) the circle touches while it moves is removed with `stroke.remove`: the stroke leaves the canvas entirely. The test is the distance between the circle's movement (segment by segment) and each segment of the stroke's path, after a quick check of the stroke bounds.
- Scope: all visible layers (default), or the active layer only (and then its mask strokes when the mask is the paint target). Mask strokes are left alone in "all layers".
- One drag is one undo step: undo restores every stroke it removed, redo removes them again. A toast counts them.
- With the tool selected, an overlay canvas shows the paths of the strokes it can remove as thin lines (a light line over a dark halo), and the strokes under the circle in red. Only strokes in view are drawn, each thinned to points about a pixel apart, and a stroke smaller than two pixels is a dot, so the cost follows the screen. The overlay redraws only when the view, the strokes or the hover set change.
- Mouse and pen hover show the circle and the red highlight; a finger shows the circle while it erases. The eraser end of a pen still paints transparency.
- The size and the scope are kept with the other preferences.

### 9.0 Layers panel, groups and transform

- The panel is a tree, top layer first: a group's row (folder icon, an arrow to open or close it; closed groups are kept per device), then its layers, indented. Every row has a grip: drag it (mouse, pen or finger) onto the upper or lower part of a row to go above or below it, or onto the middle of a group to go into it, at its top. The up and down buttons move a layer among the layers of its group.
- Buttons: new layer, new adjustment layer, group (puts the active layer in a new group; on a group: ungroup), mask, clip, duplicate, up, down, delete. The Select tool (V) transforms a paint layer or a group (section 9.8). The phone's layers sheet keeps a Transform button. Shortcuts: Ctrl+G groups, Ctrl+Shift+G ungroups, Ctrl+J duplicates, Ctrl+T transforms (browsers keep Ctrl+T for a new tab; the Select tool works there).
- On a shape layer, a brush button converts it to a paint layer (section 4.2). Undo converts it back.
- A shape layer row opens and closes, as a group row. Open, it shows its shapes, top first: the kind icon, the name (double-click renames), a chip with the fill and stroke colors, and a delete button. A click on a shape row selects the shape (Shift+click adds or removes it) and changes to the Select tool.
- New layers go above the active layer in its group, or at the top of the active group. A group cannot be painted on: the brush says so.
- Transform: a box around what the layer or group draws, with 8 handles and a rotate handle. Drag inside to move. A corner scales and keeps the shape (Shift: free; Alt: from the center). An edge stretches one way. The rotate handle turns (Shift: 15° steps). A toolbar shows the size and the angle, and has flip horizontal, flip vertical, reset, cancel and apply. Enter applies, Esc cancels, arrow keys nudge (Shift: 10 px). While the box is open the canvas only pans, and the wheel still zooms over the box.
- Preview: while the handles move, the renderer draws a copy of what the layer showed on screen through the transform (one GPU pass), so dragging stays smooth even for a large group. Parts that were off screen are missing until the transform is applied. After Apply, the preview stays until the layer's tiles show the transformed strokes, so the layer does not flash back.

### 9.1 Pen input

The client reads pens through Pointer Events: `pointerType` "pen", `pressure`, and `getCoalescedEvents()`. The eraser end of a pen (button 5, or bit 32 of `buttons`) always erases, whatever tool is selected.

| Engine | Pen and pressure |
|---|---|
| Chromium (Chrome, Edge, WebView2 in the Windows app) | Yes. On Windows, a Wacom driver must have "Use Windows Ink" on. On Linux with native Wayland, tablet support is not reliable: `--ozone-platform=x11` is a workaround. |
| Firefox | Yes, on Windows and macOS. On Linux, from Firefox 129 (X11 and Wayland). |
| WebKitGTK (the Linux app) | No. Every pointer is a mouse with pressure 0 (WebKit bug 204115). |
| WKWebView and Safari (the macOS app) | No. Pressure comes only from Force Touch trackpads, not from tablets. |

Finger pressure ("Finger pressure", on by default, shown on touch screens):

1. The touch pressure of the screen, where it has one: Android's "Prs" (`MotionEvent.getPressure`), which Chrome and the Android WebView give as `PointerEvent.pressure`. A browser without it gives exactly 0.5 while touching, so the first other value turns this source on. Values over 1 are scaled by the largest value seen.
2. Else the contact size: Android and some other browsers report the contact as `width` × `height`. A light touch is small, a firm press is wide. The range adapts to the finger and the screen: it starts around the first contact and grows with each size it sees.
3. Else (width and height 1) full pressure.

For WebKitGTK and WKWebView, the desktop app reads the pen in the native layer (`src-tauri/src/pen.rs`). On Linux, it connects to the GTK motion and button signals of the WebKitWebView and reads the device source (pen or eraser) and the pressure axis. On macOS, an AppKit local event monitor reads tablet-point and tablet-proximity events. GDK motion compression is off on the web view, so the native layer gets every pen sample. For each sample, it runs `window.__drawPen(pressure, eraser, x, y, kind)` in the page before the engine forwards the same event (x, y in CSS pixels from the top left of the web view; kind: move, press, or release). It runs `__drawPen(null)` when another device moves. The client (`engine/nativePen.ts`) uses these values only for pointer events that the engine reports as a mouse. A stroke from a native pen takes its points from the samples, not from the pointer moves: when the page is busy, WebKit merges pointer moves into one and loses the points and pressures between them. The press sample gives the offset from sample positions to client positions. If a pointer move is not near the recent sample path (24 px), the stroke continues with pointer events.

### 9.2 Files (.bdraw)

- Content: the document as the server sends it in `welcome` (`layers`: Layer[], `strokes`: Stroke[], `shapes`: Shape[]), plus a header: `format: "bdraw"`, `version`, the app version, the save time, and the source canvas (information only). Version 2 can hold adjustment layers, clipping, masks, and brush dynamics. Version 3 adds shape layers and `shapes`. Version 4 adds paths and vector strokes. Version 5 adds spline paths. Version 6 adds compound shapes. Version 7 adds ellipse arcs and holes, custom shapes, dashes and arrowheads. A file is written with the lowest version that holds it, so an older server accepts what it can read. The server reads versions 1 to 7. Deleted layers, erased strokes and removed shapes are not in the file. Type: `src/shared/bdraw.ts`.
- Encoding: gzip-compressed JSON. Plain JSON is also valid. A browser without `CompressionStream` writes plain JSON.
- Preview: `preview` is a PNG data URL of everything on the visible layers (4% margin), fitted into 512 × 512 px, rendered by the off-screen renderer (§9.4). It comes right after `savedAt`, so a reader finds it near the start of the file. It is information only, and the server ignores it. Without WebGL2 the file has no preview.
- Thumbnails (Linux): the Linux app installs `draw-thumbnailer.sh` in `~/.local/share/xyz.bsums.draw/` and `~/.local/share/thumbnailers/xyz.bsums.draw.thumbnailer` (freedesktop thumbnailer spec) when it starts, for every package type. The entry runs `sh draw-thumbnailer.sh %i %o %s APP`, where APP is the AppImage file or the app binary. The script decompresses at most the first 8 MB and writes the `preview` PNG (fast). A file without a preview (saved before Draw 0.2.24) goes to `APP --thumbnail IN OUT SIZE`: the app loads `thumb/thumb.html` (built from `thumb.html` and `src/client/thumb.ts` by `npm run build:thumb`) in a hidden window with a temporary profile, renders everything on the visible layers with the off-screen renderer (§9.4), writes the PNG and exits, in 1 to 2 s. No single-instance lock, so several can run next to the open app. The file manager scales the result. The script needs only POSIX `sh`, `gzip`, `head`, `tr`, `grep`, `sed` and `base64`.
- KDE Dolphin (KIO 6, 2024 and later) lists the thumbnailer as "Draw canvas" (the MIME type comment) under Settings, Interface, Previews. Dolphin uses only the previews ticked there, so tick it once.
- Save: the save button or `Ctrl+S` writes the confirmed state of the client. A viewer can save too, because a viewer can see the full canvas.
- Open: the open button, `Ctrl+O`, a file dropped on the window, the file manager (desktop app), or the installed PWA (Chromium `file_handlers`). The app always opens the file as a new online canvas with the same create form as the landing page. It never changes the canvas that the file came from.
- Server: `POST /api/import`. The body is the raw file (at most 32 MB, at most 256 MB after gunzip). The create options are URI-encoded JSON in the `X-Draw-Options` header. A cross-site page cannot send this header without a CORS preflight. The server reads and checks the whole file before it makes the canvas. Then it replays each layer, each stroke (in `seq` order) and each shape as `layer.add`, `stroke.add` and `shape.add` ops, through the same checks as live ops. It skips entries that fail and returns the number it skipped. Strokes and shapes keep their IDs and their author.
- Desktop app: the installers register `.bdraw` (`application/x-bdraw`). The `.deb` and `.rpm` packages install a shared-mime-info file in `/usr/share/mime/packages`. The AppImage contains the same file (AppImageLauncher installs it). Gear Lever does not install MIME types, so an AppImage writes the file to `~/.local/share/mime/packages` when it starts (only if it is missing or different) and runs `update-mime-database`. The desktop file has `Exec=draw %F`, so file managers send the paths. The app gets the path as an argument (Windows, Linux) or as `RunEvent::Opened` (macOS). It reads the file with a command that reads only the files the system opened the app with.

Shortcuts: `Ctrl+S` saves a `.bdraw` file, `Ctrl+O` opens one, `Ctrl+0` fits all content, `Ctrl+1` goes to 100%, and `M` shows or hides the markers. `[` and `]` change the size. `Shift+[` and `Shift+]` change the hardness. Keys 1–0 set the opacity. `X` swaps the colors. Hold `Space` to pan. Hold `Alt` for the eyedropper. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo. The mouse wheel zooms at the cursor. `Ctrl`+wheel and trackpad pinches zoom the canvas over the panels and popups too, never the page. A plain wheel over a popover that floats on the canvas zooms the canvas when the popover cannot scroll. `Ctrl+=`, `Ctrl+-`, `Ctrl+0` and `Ctrl+1` work while a number field or a list has the keyboard.

### 9.3 Brush presets

- A preset is brush settings without the tool and the color, with `size` in screen pixels (`BrushSettings`), plus a name. Presets are shared: every person sees every preset.
- Anyone can save a preset, also without an account. The server stores the creator as the account (`owner_id`), or else as the sha256 of the anonymous secret of the browser (`creator_anon`). It shows the creator as `u:<user id>` or `a:<16 hex of the hash>`, never the secret.
- Delete: the creator (the same account, or the same browser) or an admin (`ADMIN_EMAILS`). The server makes the check. The client shows the delete button only for those presets.
- Groups: the panel groups presets by creator, with the account name, or the display name at save time without an account. The own group is first. A group can collapse (the state is kept on the device).
- Thumbnail: the client draws the preset along a squiggle with a pressure curve (light at both ends, full in the middle), with the same dab walker and stamps as real strokes. A large brush is scaled down to fit. Grain is an approximation on the whole stroke. The server stores no images. A worker draws the thumbnails (`presetThumb.worker.ts`), so the page never stops for them, and only for the presets that scroll near the view. IndexedDB (`draw-thumbs`) keeps them by settings, size and pixel ratio, so each preset is drawn once per device. An empty box holds the place until a thumbnail is ready.
- Apply: a click sets the brush (or the eraser, while it is the tool). Settings that the preset does not hold go back to their defaults.
- API: `GET /api/presets`, `POST /api/presets` (`name`, `settings`, `anon`, `creatorName`), `POST /api/presets/<id>/delete` (`anon`). Limits: 30 saves per hour per IP address, 300 presets per creator, 5000 in total.

### 9.4 Image export

One "Export image" button in the top bar (on phones, in the ⋮ menu) opens the export dialog. It keeps its settings for next time (in the browser).

- Area: the current view, or everything on the visible layers.
- Shape: as on screen (or as drawn, for everything), or 1:1, 4:3, 3:2, 16:9, 21:9, 4:5, 2:3 or 9:16. The area is centered and widened to the shape, never cut. Paper fills the rest.
- Size: a pixel count. "Screen" is the pixel count of the view at the screen's resolution now (with the screen's shape, that is a snapshot of the screen). Presets 4, 12, 24, 50, 100, 250 and 500 MP, 1, 2.5, 10 and 50 GP, or any number of megapixels. The area is fitted to that count and keeps its shape: width = √(pixels × aspect). The dialog also shows the size as a multiple of the detail on screen now.
- Background: Paper (the paper color fills everything) or Transparent (no paper: the file keeps an alpha channel, with straight, not premultiplied, colors: an RGBA PNG, or a TIFF with 4 samples and unassociated alpha). The choice is kept per device.
- Formats:

| Format | Limit here | Notes |
|---|---|---|
| PNG | 500 000 px wide (a strip of 256 rows is held in memory), 2^31 − 1 px high | Opens everywhere. RGB (RGBA when transparent), the Sub filter, one zlib stream. |
| TIFF | 2^32 − 1 px per side | Tiled (256 × 256), Deflate with the horizontal predictor. BigTIFF (64-bit offsets) when the image is over 4 GB uncompressed. GIMP 2.10.32+, Photoshop, Krita and GDAL read BigTIFF. |

- Rendering: an off-screen WebGL2 renderer with its own copy of the document renders pieces of up to 2048 × 2048 px, each to completion, with the same code as the screen. The pieces go into the encoder as they are done. About 24 megapixels per second on a desktop GPU.
- Stages: "Choose where to save…" (the save dialog comes first, so pieces can stream to the file), then a bar with "Rendering piece N of M", the percent, the time so far and the time left (after 3 s, from the pace so far), then "Finishing and checking the file". At the end, the dialog stays open with "Saved NAME", the size in pixels and bytes, and the time. Cancel stops the export and removes the partial file. While an export runs, the browser asks before the page closes.
- Check: after a streamed save, the dialog reads the file back (size and the first 64 bytes). If the browser reported success but the file is wrong, it says so and offers "Download instead" (a normal download, up to 1.5 GB).
- Writing: the Tauri apps write the file natively (save dialog, then writes and seeks). Browsers with the File System Access API (Chromium, Edge, the Electron app) stream to the file. Other browsers (Firefox, Safari) keep the file in memory, up to 1.5 GB, then download it. The dialog warns about this.
- Without WebGL2 (no off-screen renderer), the dialog offers only a PNG snapshot of the screen. Transparency is not exported: the paper color is the background.

### 9.5 Embeds

An embed is a live, view-only copy of a canvas on another site, in an `<iframe>`.

- Address: `/e/<code>?k=<token>&r=<x>,<y>,<w>,<h>`. `r` is the world rectangle to frame. `x` and `y` keep a precision of 1/10 000 of the width. `k` is present only when the canvas link is off (then it is the private view link token).
- Get the code: Share dialog, section "Embed on a website" (owners only). The frame is the area on screen when the dialog opens. The section shows a live preview and the HTML to copy: full width (or a fixed width in pixels), with the aspect ratio of the view. If the canvas link is off and the private view link is off too, the section offers to turn on the private view link.
- The page shows only the drawing. It fits the frame in the box, centered, and fits it again when the box changes size, until the viewer moves the view.
- Controls: drag (or one finger) pans, two fingers pinch zoom. The wheel zooms only after a click inside the embed or with Ctrl. Before that, the wheel scrolls the page around the embed, and a hint says to click first. Buttons: zoom in, zoom out, back to the framed view, full screen, open in Draw.
- Server: a `hello` with `embed: true` gets access from the link only. The server ignores the account and the anonymous secret, so the owner's own preview shows what visitors see. The role is at most viewer, also with an edit link. Other people do not see an embed (no `peer.join`, `peer.leave` or cursor), and the embed sees no people.
- Framing: the server sends `Content-Security-Policy: frame-ancestors * file: data: blob:` on `/e/` pages, so any site (or a local file) can frame them. Browsers ignore `X-Frame-Options` when this rule is present, so the proxy's `X-Frame-Options: SAMEORIGIN` (sent on every response by the nginx on the server) does not block embeds. Other pages keep that protection. The code uses `allow="fullscreen"` only (`allowfullscreen` is redundant and makes Chrome warn).
- An embed cannot ask for a join password. It shows "This drawing needs a password". Rename, or turning off or resetting the link it uses, stops it.

### 9.6 Link previews

What Discord, X/Twitter, Slack, Mastodon, iMessage and others show for a `/s/` or `/e/` link. Code: `src/server/linkPreview.ts`.

- Tags: the server puts Open Graph and Twitter Card tags in the HTML of `/s/KEY` and `/e/KEY` (crawlers run no JavaScript): title (the name, or "Drawing CODE"), a description (owner, draw or watch, temporary or last change), the preview image (`summary_large_image`), and an oEmbed link. Without a preview image: the app icon (`summary`).
- Access: a crawler has no account, so the card shows what the link alone gives: the plain code of a public or view-only canvas, or a `?k=` token (the image URL carries the same token). A private link, or a canvas with a join password, gets a generic card: "A private drawing", no image, no owner.
- Image: the server cannot render, so an editor's browser does: a desktop one (the full profile, §6.2). On a phone the render froze the app for seconds. 8 s after the last change (5 s after joining), at most every 90 s, and only when the stored image shows an older `seq`, it renders everything on the visible layers (6% margin, widened to 1200:630) with the off-screen renderer and sends `{t: 'preview', png, seq, frame}`. The server keeps it when the sender can edit, the PNG is exactly 1200 × 630 and at most 1.5 MB, the `seq` is newer, and the last one is at least a minute old. It tells everyone `preview.saved`. Table `previews` (schema 5), kept on rename, deleted with the canvas.
- `GET /api/canvases/KEY/preview.png?v=SEQ&k=TOKEN`: the image, cached 10 minutes (a new image has a new `v`).
- `GET /api/oembed?url=…`: a `rich` oEmbed answer with the live embed (§9.5) as an `<iframe>`, framed like the preview image (or the `r` of an `/e/` link), 800 px wide (or `maxwidth`). 401 for a private link, 404 for other sites.
- Limits: Discord and X show images, not live pages: the image is a recent snapshot, and Discord keeps its copy of a card for a while. Sites that embed through oEmbed (directly or through Iframely, such as Notion and Medium) can show the live canvas.

### 9.7 App updates

The Android app and the Linux AppImage update themselves from the latest GitHub release. Code: `src/client/update.svelte.ts` (the logic), `ui/UpdateDialog.svelte`, `src-tauri/gen/android/.../AppUpdate.kt`, `electron/update.cjs`.

- Check: a little after start, then every 6 hours while the app is open (and when an Android app comes back after 6 hours). The start page has "Check for updates". `releases/latest` must not be a draft or a pre-release, and its tag must be newer than the app. The dialog lists the commit subjects since the installed version (GitHub's compare API).
- Dialog: Update, Later, Skip this version (not offered again until a newer one), and "Check automatically" (off: only the start page button checks). Stored in `localStorage` `draw.update`.
- Android: the page finds the asset `Draw_<ver>_android.apk`, and the app (as `window.DrawAppUpdate`) downloads it into its cache from GitHub hosts only, makes sure the file is a package of this app, and opens Android's installer. Android installs it only when the release key signed it. The first time, the dialog explains how to allow Draw to install apps and opens that setting (permission `REQUEST_INSTALL_PACKAGES`).
- AppImage: the app reads the release, downloads `Draw_<ver>_amd64.AppImage` (every redirect must stay on a GitHub host) next to the running file, checks the size, the SHA-256 that GitHub lists for the asset and the AppImage header, and renames it over the running AppImage. The path does not change, so Gear Lever's entry and desktop launchers keep working. "Restart now" starts the new file; otherwise the next start runs it. A folder the user cannot write gets the release link instead.
- `.deb` and `.rpm`: the dialog says a new version exists and opens the release page; the package manager updates the app.
- The web app and the Windows and macOS apps show nothing.
- Keep the asset names above and the `--latest` publish in `.github/workflows/release.yml`, or the apps stop finding updates. Apps before v0.2.35 have no updater: update those by hand one time.

### 9.8 Shapes and the Select tool

Toolbar order: brush, eraser, stroke eraser, the colors, eyedropper, Select, Pen, Shapes. Hand and Zoom are at the bottom. The phone bar has Select, Pen and Shapes after the eyedropper.

**Shapes tool (U).** Shift+U changes to the next kind. A click on the Shapes button when it is active, a right-click, or a long press opens a menu of the kinds: rectangle, ellipse, polygon, star, line, and arrow (a line with an arrowhead at its end). Below them, a grid of the 12 custom shapes. The menu shows only the kinds that the tool draws: paths come from the Pen, and compound shapes from Combine. The Shapes button shows the current kind (a custom shape: its outline).

- A drag draws a shape from the start point to the pointer. Shift makes a square, a circle, or a line in 45° steps. Alt draws from the center. A label near the pointer shows the size in screen pixels (and the radius of a rectangle).
- A click without a drag makes a shape of 100 screen pixels, centered at the click (a line starts at the click).
- The new shape goes into the active layer when it is a visible shape layer. Else the press makes a new shape layer above the active layer. Undo removes the shape, and the new layer with it.
- After the drag, the new shape is selected. The tool stays the Shapes tool.

**Select tool (V)** on shapes. The rules prevent a change of the selection by accident:

- Hover: an outline shows the shape that a click would select, with a label "Click: select <name>".
- A click on a shape selects it, and the active layer changes to its layer. Shift+click adds the shape to the selection or removes it. A press on a shape that is not selected and a drag move it at once.
- With a selection, a press anywhere inside its box moves it, also over other shapes: the box wins. A handle scales. A press just outside a corner (26 px) rotates (Shift: 15° steps). A dot inside each corner of a rectangle changes the corner radius (all four when they are linked, Alt: one corner). A polygon has a dot inside each corner and a star one inside each point; any of them changes the one rounding radius of all corners. Each dot sits on the center of its corner's arc, at least 14 px in from the corner; the label near the pointer shows the radius. Shapes under 44 px on screen show no dots. A line has a handle at each end instead of a box. The cursor shows what a press does.
- A resize of one shape changes its frame: Shift keeps the proportions, Alt resizes from the center. With several shapes selected, the box is around all of them, and a resize scales their matrices.
- A drag on empty canvas selects the shapes that its rectangle touches (Shift adds them). A click on empty canvas deselects. "Keep selection" in the options bar (kept per device) locks a selection: while it is on and something is selected, a press outside the box neither selects another shape nor deselects nor starts a selection rectangle, and the hover outline does not show. Shift+click still adds or removes a shape. Esc and the Deselect button always deselect. With nothing selected, clicks select as usual.
- A press must move 3 px (7 px with a finger) before it changes a shape. Thus a click never moves a shape.
- Delete or Backspace removes the selected shapes. The arrow keys move them by 1 screen pixel (Shift: 10).
- Duplicate: Ctrl+D, or the Duplicate button in the options bar. With shapes in the selection, Ctrl+J does the same. Without them, Ctrl+J duplicates the layer. The copies go 10 screen pixels down and right. Each copy goes right above its original in its layer. The copies become the selection.
- Alt+drag in the selection box drags copies away. The originals stay in place. Esc during the drag adds nothing.
- A copy with an automatic name ("Rectangle 2") gets the next free number. A name that someone chose stays. One undo step removes the copies. This does not copy parts of a compound shape.
- A double-click (a double tap on a phone) or Enter starts point editing of the shape (below). On a compound shape, it starts parts mode (below).
- One drag is one undo step for all the shapes that it changed.
- On a paint layer or a group with paint, the Select tool shows the layer transform (section 9.0): the whole layer is the selection. While that transform has no change, a click on a shape closes it and selects the shape. A transform with changes stays until Apply or Cancel.

**Options bar** (the phone shows the same options in the tool sheet, with the kinds as buttons):

- The corner radius and the rounding sliders are logarithmic, like flow and spacing: fine steps at small radii. The first 5% of the track is 0; the rest runs from 0.5 to 500 screen pixels.

- The Fill and Stroke swatches open a color picker with "None", the foreground and background colors, and the recent colors. Width (screen pixels), alignment (Inside, Center, Outside), the corner radius of a rectangle (one radius, or four when not linked), sides and rounding of a polygon, points, inner ratio and rounding of a star, and the caps of a line.
- Ellipse: "Arc" (the start and end angle, in degrees) and "Hole" (a percent of the size). Custom shape: "Shape", a button with the outline that opens a grid of the 12 outlines (the phone shows the grid in the sheet). Lines, open paths and the Pen: "Start" and "End" (None, Arrow, Open arrow, Circle, Bar). Any shape except a compound: "Dash" (Solid, Dashed, Long dash, Dotted). Dotted also sets round caps. With a dash pattern, the caps show for closed shapes too.
- With shapes selected, the options show the first shape and change all the selected shapes where the setting fits their kind. A slider drag is one undo step. The values also become the style of the next shape.
- The bar shows the gestures as text: "Drag inside: move · Alt+drag: copy · Handles: scale · Just outside a corner: rotate · Double-click: points" ("Double-click: parts" for a compound shape).
- With one path selected, "Curve: Bezier | Spline" changes its curve type (one undo step).

**Multiplayer.** During a drag, the client sends the changed shapes in `shape.live` at most every 40 ms. Other people see the drafts at once. At the end of the drag, one `shape.update` op for each shape goes out, then an empty `shape.live`. A client drops the drafts of a person who leaves, or who sends nothing for 10 s.

**Point editing.** A double-click on a shape, or Enter with one shape selected, shows its points: squares for corners, circles for smooth points. The selected points show their handles.

- A click on a point selects it (Shift+click adds or removes it). A drag moves the selected points (Shift: along one axis). A drag on empty canvas selects points by rectangle.
- A drag on a handle moves it. A smooth point turns its other handle to stay on one line; a symmetric point mirrors it. Alt+drag breaks the handles apart: the point becomes a corner. Shift: 45° steps.
- A double-click on a point changes it from corner to smooth (handles along the line between its neighbors) or back (no handles). A double-click on the outline adds a point there without changing the curve.
- Delete removes the selected points. A contour left with one point goes, and a shape without contours is removed. The arrow keys move the selected points by 1 screen pixel (Shift: 10).
- A bar at the bottom shows the number of points and has Corner, Smooth, Delete and Done.
- Esc, Enter, Done, or a click outside the shape ends point editing. A click on the shape (not on a point) clears the points.
- The first change of a shape that is not a path makes it a path (one `shape.update` with the kind). Each drag is one undo step.
- On a spline, the points show no handles. A selected point shows a ring around it with a knob. The knob is at the top for a corner. A drag of the knob clockwise makes the point softer (a blue arc, up to 1). A drag counterclockwise makes the curve go through the point (an orange arc, up to -1). The two ends stop at a 30° gap at the bottom of the ring, as on a balance knob. A pointer that goes past an end, across the gap, leaves the knob at that end. The knob moves again when the pointer comes back to it. Thus soft and through never swap at the bottom: to go from one to the other, the knob goes back over the top, through a corner. The bar has Corner (0), Through (-1), Soft (1) and "To Bezier". The bar of a Bezier path has "To spline". A double-click on a spline point changes it from corner to through, or back. A point added on the outline of a spline goes through (-1).

**Pen tool (P).** It draws a path point by point. New paths start with no fill and a 3 px stroke (`ed.penStyle`, kept per device).

- A click makes a corner point. A drag makes a point with handles: the outgoing handle follows the pointer and the incoming one mirrors it. Alt+drag moves only the outgoing handle (a corner).
- A dashed line shows the next segment. Near the first point, a label says "Click the first point to close the shape". A click there closes the path and ends it (a drag there shapes the closing curve).
- Enter, Esc or Done ends an open path. Backspace, Ctrl+Z or "Undo point" takes back the last point. Another tool also ends the path. A path needs two points, or it goes.
- The path is a draft until it ends, so other people see it grow. Then one `shape.add` goes out (one undo step), on the active shape layer or a new one above the active layer.
- With one shape selected and no path in progress, a click on its outline adds a point and a click on its point removes it.
- "New points: Bezier | Spline" in the options bar sets the curve type of the next path. It shows whenever the Pen is the active tool, also with a shape selected. In spline mode, a click adds a point with the smoothness of the Smoothness slider (-100% to 100%, -1 to 1), and a drag places the point. The curve shows through or near the points at once.

**Compound shapes.** A compound shape combines shapes live (section 4.1).

- With two or more shapes selected on one layer, the options bar shows "Combine: Unite, Subtract, Intersect, Exclude". A click makes one compound shape of them, in one undo step. The bottom shape is the first part and gives the style. The other parts combine with it by the op, from the bottom up. The compound goes at the place of the top shape, with the name of its op ("Union 1", "Subtraction 1", "Intersection 1", "Exclusion 1"). A selected compound becomes a part as its flattened outline. Lines cannot be combined.
- With a compound selected, the options bar shows its op (it sets the op of every part), "Edit parts", "Release" and "Flatten to one path". Release makes the parts separate shapes again, with the style of the compound. Flatten makes the compound one Bezier path, the outline of the result: the parts are no longer live. Both are one undo step.
- Parts mode: a double-click on a compound, Enter, or "Edit parts" shows the outlines of its parts (dashed), and a double-click also selects the part under the pointer. A click selects a part, Shift+click adds or removes one. A selected part moves, scales and rotates as a shape, and the compound shows the change live. A double-click on a part starts point editing of that part. The options bar shows the op of the selected parts ("Part: Unite, Subtract, Intersect, Exclude"), or "Bottom part: the base" for the first part. A change of fill, stroke or width changes the whole compound. Delete removes the selected parts (a compound without parts goes). A bar at the bottom says "Parts of <name>" and has Delete and Done. Esc, Done, or a press outside the parts ends parts mode, and the compound is selected again. Esc in point editing of a part goes back to parts mode first.
- A part has the id `<compound id>~<index>` in the editor only. Each change of a part is one `shape.update` of the compound (its `parts`, `w`, `h` and `m`), so undo, other people and late joiners need nothing new.
- The layers panel shows the parts under their compound, top first, each with its op ("Base" for the first part). A click on a part row starts parts mode with that part selected.

**Shapes made paint.** "To paint layer" in the options bar puts the selected shapes on a new paint layer above their layer, as vector strokes (section 4.2). One undo step brings the shapes back and removes that layer.

**Painting on a shape layer.** The brush, the eraser and the stroke eraser (on the active layer only) do not paint on a shape layer. A message tells the person to select a paint layer, or to add one.

### 9.9 Canvases on this device

A canvas can live on the device only, with no server. Every app has these canvases: the browser, the desktop apps and the Android app. Code: `src/client/local/`.

- Make one: "New canvas on this device" on the start page, or "Open on this device only" for a `.bdraw` file. When "New canvas" cannot reach the server, the app makes the canvas on the device. A message tells why. Opening a file does the same.
- Address: `/l/ID`. (An online canvas is `/s/CODE`.) The start page lists these canvases under "only on this device", the latest change first. A × deletes one after a confirm, because no other copy exists.
- Storage: the IndexedDB database `draw-local`. It keeps a canvas as the server does: a row for each canvas (`canvases`) and the op log (`ops`, keyed by canvas and seq). Opening a canvas replays its log. A new canvas gets the date and time as its name ("Drawing, 10 Oct 14:32"). A canvas from a file gets the file name.
- Behavior: `LocalNet` takes the place of the WebSocket. It answers the engine as the server answers one person. A `hello` gets a `welcome` with the document and the role `editor`. An `op` goes through `validateOp` and the op rules of the server (`src/shared/docState.ts`, shared with `session.ts`). Then `LocalNet` confirms or rejects it. Thus drawing, shapes, layers, undo, redo, export and `.bdraw` files work as on an online canvas. Live strokes, cursors and link previews are for other people, so `LocalNet` drops them. It writes ops in batches, 50 ms after a change.
- One window at a time: a Web Lock (`draw-local-ID`) holds an open canvas. Another window shows "Open in another window". Two windows would both number their ops.
- Signs: the top bar shows the name and "Put online". The banner says "Only on this device · Put it online to share it". The status bar says "on this device".
- Put online: the app sends the canvas to the server as a `.bdraw` file. It uses the form for a new canvas: temporary without an account, named, private or public with one. Then the canvas leaves the device, and the app opens the online canvas. To keep a copy on the device, save a `.bdraw` file first.
- A `.bdraw` file opened on the device: the app reads it there (gzip through `DecompressionStream`). It applies the checks and the order of the server's import (`importOps`). The app leaves out damaged items and shows their count.

## 10. Deployment

- Build: `npm run build` writes `dist/client` (Vite) and `dist/server/index.js` (esbuild).
- Deploy: `npm run deploy` builds, copies the build to `~/draw` on the server, installs the runtime packages, and reloads pm2.
- Release: every push to `main` runs `.github/workflows/release.yml` on GitHub-hosted runners. It type-checks, builds the web/server bundle and the desktop installers (Linux, Windows, macOS universal), and publishes them as a GitHub Release `vMAJOR.MINOR.RUN`. MAJOR.MINOR come from `package.json`. The patch is the run number, so each push has a new version and `dnf upgrade` works. The client shows the version, and `/api/health` reports the version of the server.
- Server update: `bash /opt/draw/update-server.sh` downloads `draw-web.tar.gz` from the latest release (or a given tag), installs the runtime packages, swaps `dist/` only after the install succeeds, and restarts the service. It never touches the database. GitHub has no access to the server.
- Run: the systemd service `draw.service` (made by `deploy/setup-systemd.sh`). It runs as the system user `draw`, with a read-only system, no access to `/home`, and no capabilities. The app is in `/opt/draw`, and the database is in `/var/lib/draw`. The server listens on `127.0.0.1:3210`. A sudo rule lets the deploy user restart the service and read its status and logs, and nothing else.
- SMTP: the password is in `/etc/draw/smtp.cred`, encrypted with `systemd-creds` and the host key (root only). systemd decrypts it only into the private RAM folder of the service when it starts. It is never in an environment variable, a plain file, or the repository. Without SMTP in production, register and reset refuse with `mail_unavailable`.
- nginx: a server block for `draw.bsums.xyz` sends all traffic to the Node port, with the WebSocket upgrade headers for `/ws`. `/api/import` allows 33 MB bodies (the nginx default is 1 MB). TLS comes from the existing certbot setup.
- Data: `DB_PATH` (`/var/lib/draw/canvas.db` on the server). Back up this one file.
- Settings: `PUBLIC_URL` (links in emails), `ADMIN_EMAILS` (adopt legacy canvases), `TEMP_TTL_MS` and `CLEANUP_EVERY_MS` (expiry, for tests).

Android app (Tauri v2, `src-tauri/gen/android/`):

- The same bundled client as the Windows and macOS apps, in the Android System WebView (Chromium). Thus WebGL2, pen pressure, and touch size work as in Chrome. The app talks to `https://draw.bsums.xyz` from the origin `http://tauri.localhost`, which the server allows for CORS.
- CI builds one universal APK for arm64, armv7, and x86_64 (`Draw_<version>_android.apk`). The version code comes from the version (major × 1 000 000 + minor × 1000 + patch), so each release installs over the one before.
- Signing: a release keystore in the GitHub secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, and `ANDROID_KEY_ALIAS`. CI writes `keystore.properties` from them. Android installs an update only with the same key, so the keystore has a backup outside GitHub. A local build without `keystore.properties` makes an unsigned APK.
- Local build: JDK 17 or 21, the Android SDK and NDK, and the Rust Android targets, then `npx tauri android build --apk`.

Desktop app on Linux (Electron, `electron/`):

- WebKitGTK (the Tauri engine on Linux) gives pages no pen pressure, merges pointer moves, and with the NVIDIA driver its WebGL is much slower than a browser's. Thus the Linux app is Chromium (Electron).
- The page comes with the app, as in the Tauri apps: `npm run linux:app` builds the client with `vite build --mode tauri` (it talks to `https://draw.bsums.xyz`) and copies it to `electron/app/`. Thus the app starts without a connection, and the version on the page is the version of the package. The app serves the page at `tauri://localhost` (`protocol.handle`): a file of `app/` is itself, any other path is the page's `index.html` (the routes, as `/s/CODE`). This is the origin of the Tauri app on macOS, which servers already allow for `/api` (`CORS_ORIGINS`). Thus the app also works with a server that is not updated. Only this origin runs in the window. Other links open in the default browser.
- Move from the hosted site: apps before v0.2.48 showed `https://draw.bsums.xyz`, so their storage is under that origin. A newer app moves it once, at its first start, before the page opens. It copies the old origin's `localStorage` to the page's origin: recent canvases, settings, and the anonymous identity that owns temporary canvases. Keys that the new origin already has stay. The login cookie becomes the page's bearer token, because the server takes the same session token both ways. The move needs no network: the app answers the old origin's page itself. The file `site-storage-moved` in the app's data folder marks it done.
- Pen input, pressure, and WebGL come from Chromium, as in a browser (section 9.1). On a Wayland desktop, the app uses native Wayland (pen through `zwp_tablet_v2`). Under XWayland with the NVIDIA driver, the GPU process crashed and WebGL was lost (RTX 3090, KDE Plasma). `DRAW_OZONE=x11` forces X11.
- `.bdraw` files: the app is single-instance. Paths from the command line go to the page through the preload bridge (`window.drawDesktop.onOpenFile`). Downloads use the Chromium save dialog. The AppImage registers the MIME type for the user, as the Tauri AppImage did.
- Packages: AppImage, `.deb`, `.rpm` from electron-builder, with the same file names as before. Thus updaters (Gear Lever) continue to work.

Desktop app on Windows and macOS (Tauri v2, `src-tauri/`; the Linux parts of `src-tauri/` are kept for local builds):

- The app is the same web client in a native window. `vite build --mode tauri` reads `.env.tauri` and sets `VITE_SERVER_ORIGIN=https://draw.bsums.xyz`. Thus the app uses the hosted server, and share links point to the public site.
- The server sends CORS headers on `/api` only to the Tauri origins (`tauri://localhost`, `http(s)://tauri.localhost`). `CORS_ORIGINS` can change the list.
- The app has no service worker. "Export PNG" and "Save .bdraw" use the native save dialog (dialog and fs plugins).
- The AppImage contains WebKitGTK and GTK from Ubuntu 22.04 (the build machine). With the NVIDIA driver, that build is much slower than the WebKitGTK of the distribution. Thus, when the system has `libwebkit2gtk-4.1.so.0`, the AppImage starts the app again with the system library folder first in `LD_LIBRARY_PATH`. The bundled libraries fill only the gaps. It removes the launcher variables that point GTK, GIO, and GdkPixbuf at bundled modules, and removes the AppImage folder from `XDG_DATA_DIRS` (old GSettings schemas). The first process waits and exits with the status of the app; the app ends if the first process is killed. If the loader cannot start the app (exit status 127), the first process continues with the bundled libraries. `DRAW_SYSTEM_WEBKIT=0` keeps the bundled libraries.
- On Linux, the app sets `__NV_DISABLE_EXPLICIT_SYNC=1`. NVIDIA explicit sync on Wayland crashes the WebKitGTK GPU path. Disabling the GPU path instead makes every frame one frame late.
- In WebKit (the Linux app, Safari), both renderers draw two more identical frames after the view stops changing. Thus the last frame always shows.
- GitHub Actions builds the installers for Linux, Windows, and macOS (universal). `npm run desktop:build` makes them for the current OS only. The Windows and macOS builds are not code-signed yet.

## 11. Future work

- Photoshop-style features, ranked by effort with implementation notes: [docs/ROADMAP.md](docs/ROADMAP.md) (adjustment layers, clipping masks, layer masks, brush textures, layer FX and blur, blur brushes, liquify, smudge)
- Sign-in with Authentik (OIDC), Google, GitHub, Discord, and Facebook, through the `identities` table
- Email invites for people without an account, and "request access"
- Account settings: change email or name, delete the account
- Snapshots of the op log, so a large session loads fast
- Baked raster tiles at coarse LODs, so a dense area renders fast at low zoom
- Code signing for the Windows and macOS installers
- A spatial index for the markers, for documents with more than about 100 000 strokes
- Coordinate rebasing, for zoom without the float64 limit (about 15 orders of magnitude around the work area)
- Shapes, later: faster shape tiles at far zoom-out (each tile draws every shape that touches it), dashes on compound shapes, and on-canvas handles for ellipse arcs
- Pixel selection, fill, and text tools
- Export of a region at a chosen resolution, and PSD export

## 12. Risks

- Render time grows with the number of strokes in a tile. Zoomed-out views of dense areas are the worst case. Baked tiles (section 11) fix this.
- A stroke at a coarse LOD can have many dabs smaller than one pixel. The worker clamps the dab size to one pixel and scales its alpha. Thus the look at low zoom is close, but not exact.
- The code is the only protection of a session. Anyone with the link can draw or delete.
