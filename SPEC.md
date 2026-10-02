# Multiplayer Canvas — Technical Spec

Version 0.1, 2026-10-02. Target host: `draw.bsums.xyz`.

## 1. Goal

The app is an infinite drawing canvas in the browser. Many people can paint in one session at the same time. A person joins a session with a share code. There are no user accounts in v1.

## 2. Scope of v1

In scope:

- Infinite canvas with pan and zoom
- Brush and eraser with size, opacity, flow, hardness, and spacing
- Pen pressure for size and flow
- Airbrush build-up: paint builds up while the pen stays still
- Color picker (HSV square, hue strip, hex field) and eyedropper
- Shared layers: add, delete, rename, reorder, hide, opacity, blend mode
- Undo and redo for each user
- Live view of the strokes and cursors of other users
- Sessions that stay after a server restart
- Export of the current view as PNG

Out of scope for v1: selections, transforms, text, shapes, fill, PSD export. User accounts are future work (section 11).

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
Layer  { id, name, order: number, blend: BlendMode, opacity: 0..1, visible, deleted }
Stroke { id, layerId, seq, author, brush: Brush, pts: number[], deleted }
Brush  { tool: 'paint' | 'erase', color: '#rrggbb', size, opacity, flow,
         hardness, spacing, pressureSize, pressureFlow, buildup }
```

- `pts` is a flat array of `x, y, pressure` triples in world units. One world unit is one CSS pixel at 100% zoom.
- `order` is a fractional index. A move sets `order` to the midpoint of the two neighbor layers. Thus a reorder is one property write, and two users can reorder at the same time without a conflict.
- Delete is a tombstone (`deleted: true`). A tombstone makes undo of a delete possible.
- A stroke keeps the `seq` of its creation. If a user restores a stroke, it goes back to its original position in the z-order.

## 5. Brush model

A stroke is a sequence of dabs. A dab is one stamp of the brush tip.

| Parameter | Range | Effect |
|---|---|---|
| size | 1–1000 | Diameter of the dab in world units |
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

The tip is a radial stamp. The alpha is 1 inside `hardness × radius`, then a cosine falloff goes to 0 at the radius. The outer edge has one pixel of antialiasing. A cache keeps stamps by color, hardness, and size bucket (power of two).

For airbrush build-up, the client adds a point at the same position every 30 ms while the pen stays still. When `buildup` is on, a zero-length segment gives one dab. The points carry the build-up, so a replay gives the same result.

The dab walker is one shared module (`src/shared/brush.ts`). The worker and the main thread use the same module. Thus the same points always give the same dabs.

## 6. Rendering pipeline

### 6.1 Tiles and level of detail

- A tile is 256 × 256 device pixels for one layer.
- The level of detail (LOD) is an integer. A tile at LOD `L` covers `256 × 2^L` world units.
- The client selects `L` from the device scale (zoom × devicePixelRatio). Negative `L` gives sharp tiles at high zoom. This is the benefit of vector storage.
- The tile key is `layerId | L | tx | ty`.

### 6.2 Tile worker

The worker holds a copy of all confirmed strokes. It does not keep tile pixels.

- The main thread sends the view (LOD, tile range, visible layers).
- The worker renders each tile in the view that the main thread does not have, or that is stale. It renders from the center of the view out, in time slices of about 10 ms. Between slices, it reads new messages, so a new view cancels old work.
- A tile render draws every stroke that touches the tile, in `seq` order, each through its own stroke buffer (section 5).
- A tile with no strokes goes back as `null`, without a render.
- The worker sends each tile as an `ImageBitmap` with zero-copy transfer.
- When a stroke is added or removed, the worker marks the affected tiles as stale. The main thread keeps a stale tile on screen until the new tile arrives. Thus the canvas does not flash.
- When no stale tile stays in the view, the worker sends `rendered(seq)`.

### 6.3 Compositor (main thread)

On each animation frame that has a change, the compositor does these steps:

1. Fill the view with the paper color.
2. For each visible layer, from the bottom up, draw its tiles with the layer opacity and the blend mode. Tile edges snap to whole device pixels, so tiles do not show seams.
3. If a layer has a stroke in progress, compose that layer in a scratch canvas first. Then composite the scratch canvas onto the view.

If a tile is missing, the compositor draws the parent tile (up to three LODs coarser) or the four child tiles, scaled. Thus zoom never shows holes.

Canvas 2D gives all blend modes: normal, multiply, screen, overlay, darken, lighten, color dodge, color burn, hard light, soft light, difference, exclusion, hue, saturation, color, luminosity, and add.

### 6.4 Strokes in progress

- The local stroke draws into a screen-size buffer at the time of the pointer event. The input uses `getCoalescedEvents()` for full pen rate.
- Remote strokes in progress arrive as `live` messages every 40 ms. Each one draws into its own buffer.
- After a pan or zoom, the client draws each buffer again from its points.
- At pointer up, the client sends `stroke.add`. The buffer stays on screen until the worker sends `rendered(seq)` for that stroke. Then the client removes the buffer.

## 7. Sync protocol

Transport: JSON over WebSocket at `/ws?code=XXXX-XXXX`, with permessage-deflate.

| Direction | Message | Persisted | Purpose |
|---|---|---|---|
| S→C | `welcome` | — | Client id, peers, full document, current `seq` |
| C→S | `op` | yes | One document op (table below) |
| S→C | `op` | — | The op with its `seq` and author, to all clients |
| C→S→C | `live` | no | Points of a stroke in progress |
| C→S→C | `cursor` | no | Cursor position and active layer (max 20/s) |
| S→C | `peer.join`, `peer.leave` | — | Presence |
| S→C | `error` | — | Rejected op, with a reason code |

Ops: `stroke.add`, `stroke.remove`, `stroke.restore`, `layer.add`, `layer.update` (any of name, blend, opacity, visible, order), `layer.remove`, `layer.restore`.

Consistency:

- The server is the sequencer. Each client applies ops in `seq` order, so all clients converge.
- The client keeps two states: the confirmed state (ops from the server) and a list of its own pending ops. The UI shows the confirmed state with the pending ops on top. When the echo of a pending op arrives, the client removes it from the pending list.
- Concurrent `layer.update` writes use last-writer-wins by `seq`, one property at a time.
- Strokes do not conflict. Each stroke is its own object.

Undo and redo are local to each user. Each user has a stack of their own actions. Undo sends the inverse op: `stroke.remove` for a stroke, `layer.update` with the old values for a property change, `layer.restore` for a layer delete.

## 8. Server

- Node 20 or later, `ws`, `better-sqlite3`, no framework.
- `POST /api/sessions` makes a session and gives back its code. `GET /api/sessions/:code` tells if a session exists.
- All other paths give the static client. `/s/:code` gives `index.html`.
- A session code has 8 characters from a 31-character set with no look-alike characters (format `XXXX-XXXX`, about 8 × 10^11 codes). The code is the only access control. Thus it must be hard to guess.
- The server loads a session into memory at the first join. It unloads the session 5 minutes after the last client leaves.

SQLite schema:

```sql
sessions(code TEXT PRIMARY KEY, created_at INTEGER, last_active_at INTEGER, seq INTEGER)
ops(code TEXT, seq INTEGER, client_id TEXT, type TEXT, data TEXT, created_at INTEGER,
    PRIMARY KEY (code, seq))
```

At load, the server replays the op log to build the document. Limits: 4 MB per message, 20 000 points per stroke, 100 layers per session, 10 new sessions per minute per IP address. The server checks each op for type, range, and size before it accepts the op.

## 9. User interface

The layout is close to Photoshop, but simpler, with a dark theme.

- Top bar: app name, session code with a copy-link button, peer avatars, connection state
- Options bar: the settings of the current tool (size, opacity, flow, hardness, spacing, pressure, build-up)
- Left toolbar: brush (B), eraser (E), eyedropper (I), hand (H), foreground and background colors
- Right panels: Color, Layers
- Status bar: zoom, cursor position in world units, stroke count

Shortcuts: `[` and `]` change the size. `Shift+[` and `Shift+]` change the hardness. Keys 1–0 set the opacity. `X` swaps the colors. Hold `Space` to pan. Hold `Alt` for the eyedropper. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo. The mouse wheel zooms at the cursor.

## 10. Deployment

- Build: `npm run build` writes `dist/client` (Vite) and `dist/server/index.js` (esbuild).
- Run: pm2 with `ecosystem.config.cjs`. The server listens on `127.0.0.1:${PORT}` (default 3210).
- nginx: a server block for `draw.bsums.xyz` sends all traffic to the Node port, with the WebSocket upgrade headers for `/ws`. TLS comes from the existing certbot setup.
- Data: `DB_PATH` (default `./data/canvas.db`). Back up this one file.

## 11. Future work

- User accounts: sign-in, owned sessions, invite links, roles (view or edit). Not designed yet.
- Snapshots of the op log, so a large session loads fast
- Baked raster tiles at coarse LODs, so a dense area renders fast at low zoom
- WebGL compositor, if Canvas 2D becomes the bottleneck
- Touch gestures: two-finger pan and pinch zoom
- Selection, transform, fill, and text tools
- Export of a region at a chosen resolution, and PSD export
- A cleanup policy for sessions that nobody uses

## 12. Risks

- Render time grows with the number of strokes in a tile. Zoomed-out views of dense areas are the worst case. Baked tiles (section 11) fix this.
- A stroke at a coarse LOD can have many dabs smaller than one pixel. The worker clamps the dab size to one pixel and scales its alpha. Thus the look at low zoom is close, but not exact.
- The code is the only protection of a session. Anyone with the link can draw or delete.
