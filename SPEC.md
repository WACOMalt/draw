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
- Save a canvas to a `.bdraw` file, and open a `.bdraw` file as a new online canvas (section 9.2)
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
Layer  { id, name, order: number, blend: BlendMode, opacity: 0..1, visible, deleted,
         kind?: 'paint' | 'adjust', adjust?: Adjust, clip?: boolean,
         mask?: { id, enabled } | null }
Stroke { id, layerId, seq, author, brush: Brush, pts: number[], deleted, mask?: maskId }
Brush  { tool: 'paint' | 'erase', color: '#rrggbb', size, opacity, flow,
         hardness, spacing, pressureSize, pressureFlow, buildup,
         tip?, angle?, roundness?, followDirection?, sizeJitter?, angleJitter?,
         scatter?, opacityJitter?, grain?, grainScale?, grainStrength? }
```

All fields with `?` are optional. Older documents have none of them and stay valid without a migration.

- **Adjustment layer** (`kind: 'adjust'`): it has no paint. It changes the composite of everything below it. `Adjust` is levels, curves (2 to 16 points), hue/saturation, or brightness/contrast. The server refuses a plain stroke on an adjustment layer. A mask stroke is permitted.
- **Clipping mask** (`clip: true`): the layer shows only where the nearest layer below it that is not clipped (the base) has alpha. The base and its clipped layers are a clipping group.
- **Layer mask** (`mask`): strokes with `mask: <mask id>` on the layer. They paint grey on an implied white mask: black hides the layer, white shows it, and the eraser goes back to white. A new mask gets a new id. Thus the strokes of a deleted mask stay out of a later mask, and undo of the delete brings them back. `enabled: false` turns the mask off and keeps it.

- `pts` is a flat array of `x, y, pressure` triples in world units. One world unit is one CSS pixel at 100% zoom.
- `brush.size` is in world units. The client sets it from the brush size in screen pixels, divided by the zoom at the start of the stroke. Thus a 24 px brush draws a 24 px line at any zoom.
- The client rounds each point to about 0.1 device pixel at the zoom of the stroke. The precision follows the zoom, so a stroke at 1e6× keeps its detail.
- `order` is a fractional index. A move sets `order` to the midpoint of the two neighbor layers. Thus a reorder is one property write, and two users can reorder at the same time without a conflict.
- Delete is a tombstone (`deleted: true`). A tombstone makes undo of a delete possible.
- A stroke keeps the `seq` of its creation. If a user restores a stroke, it goes back to its original position in the z-order.

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

### 6.1 Tiles and level of detail

- A tile is 256 × 256 device pixels for one layer.
- The level of detail (LOD) is an integer. A tile at LOD `L` covers `256 × 2^L` world units.
- The client selects `L` from the device scale (zoom × devicePixelRatio). The range is −45 to 40. Negative `L` gives sharp tiles at high zoom. This is the benefit of vector storage.
- If a full stroke is smaller than 2 pixels at a tile's LOD, the renderer draws it as one dot. Thus a far zoomed-out view stays fast.
- The tile key is `layerId | L | tx | ty`.

### 6.2 WebGL2 renderer

- **Dabs:** one instanced draw call for each stroke and tile. The CPU computes each dab position relative to the target in double precision and sends small float32 numbers to the GPU. Thus deep zoom stays exact. A dab with a radius over 10^6 px gets a closer virtual center with the same edge. The fragment shader uses the same profile as the Canvas 2D stamp: a solid core, a cosine falloff, and one pixel of edge antialiasing.
- **Tiles:** each tile is a float texture. The renderer updates tiles on the main thread in slices of about 6 ms per frame, from the center of the view out. A new stroke on top of a tile draws over the existing pixels. A removed or restored stroke makes the tile render again. A stale tile stays on screen until the new one is ready.
- **Strokes in progress:** each one has a screen-size float buffer. New dabs draw into it as points arrive. After a pan or zoom, the buffer draws again from its dabs.
- **Dab shader:** each dab instance has a rotation. The fragment shader applies the rotation and the roundness, then uses the analytic round profile or samples the tip from a texture array with mipmaps (the GPU selects the mip level from the dab size). Grain multiplies the alpha with a tileable texture. The CPU reduces the grain origin modulo one grain tile, so the numbers stay small at any zoom.
- **Compositing:** the layers stack in a float buffer that starts with the paper color. A normal layer without a stroke in progress or a mask goes straight onto the stack with hardware blending. Other layers go into a layer buffer first, and a blend shader combines that buffer with the stack (two buffers in turn). The blend shader uses the W3C Compositing and Blending formulas, which include hue, saturation, color, and luminosity.
- **Layer masks:** mask strokes have their own tile set (key `<layer>#<mask id>`). The renderer draws the mask tiles and mask strokes in progress into a mask buffer. A shader turns the grey into visibility `v = grey + (1 − alpha)` and multiplies the layer buffer by `v`.
- **Clipping groups:** the base draws into a group buffer. Each clipped layer then draws with its blend mode, but only where the base has alpha (source-atop: the group alpha does not change). The group then goes onto the stack with the blend mode and opacity of the base.
- **Adjustment layers:** one full-screen pass reads the stack and writes the adjusted result, mixed by the layer opacity and the mask visibility. Levels, curves, and brightness/contrast use a 1024-entry tone lookup texture (`src/client/engine/adjust.ts`). Hue/saturation uses HSL math in the shader. Inside a clipping group, an adjustment layer changes only the group.
- The mask and group buffers are made at the first frame that needs them.
- **Output:** the stack goes to the 8-bit canvas with a small triangular dither, so gradients do not show bands.
- **Context loss:** a phone or a PWA in the background can lose the GPU context. The renderer then makes all GPU resources again and renders the tiles again.

### 6.3 Canvas 2D renderer (fallback)

A worker holds a copy of all confirmed strokes and renders tiles with OffscreenCanvas. It sends each tile to the main thread as an `ImageBitmap` with zero-copy transfer. The main thread composites the tiles with Canvas 2D blend modes. Strokes in progress draw on the main thread with the same brush code.

The fallback draws tips, rotation, roundness, and jitter, but not grain. It applies layer masks and adjustment layers on the CPU (`getImageData`), with the same formulas as the shaders. A clipped layer uses `source-atop`, so its blend mode is not applied (Canvas 2D has no blend mode with atop).

### 6.4 Strokes in progress and the handoff

- The local stroke draws at once. The input uses `getCoalescedEvents()` for full pen rate.
- Remote strokes in progress arrive as `live` messages every 40 ms. Each one draws into its own buffer.
- At pointer up, the client sends `stroke.add`. The buffer stays on screen until the tiles show the stroke. Then the client removes the buffer.

## 7. Sync protocol

Document features: `welcome.features` lists the newer features the document uses (`adjust`, `clip`, `mask`, `tips`, from `src/shared/features.ts`). A client that does not know a feature shows "This canvas uses features from a newer Draw" and does not draw the canvas silently wrong. A `live` message for a stroke on a mask carries `mask`.

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

- Email and password. The server stores the password as a scrypt hash (random salt, N = 2^15). A new account must open the confirmation link (valid 48 hours) before it can log in. The server deletes accounts that stay unconfirmed for 48 hours.
- Password reset by email (link valid 2 hours, one use). A reset logs out all other sessions.
- The web app uses an httpOnly, Secure, SameSite=Lax session cookie (30 days, sliding). The desktop app uses a bearer token, because its page has another origin.
- Session, email, and device tokens are 256 random bits. The database keeps only their sha256.
- The `identities` table (provider, subject, user) is ready for sign-in through Authentik, Google, GitHub, Discord, or Facebook later.
- Register, forgot, and resend never tell if an email has an account. Login runs scrypt also for unknown emails, so its time tells nothing.
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

1. Owner.
2. Member role. The owner adds a member by the email of a confirmed account.
3. Link role: the best of the token and the canvas link. `?k=` with the private edit token gives editor. `?k=` with the private view token gives viewer. The plain code gives what the owner set for the canvas link. A wrong token gives only what the plain code gives. Link tokens are 128 random bits (22 characters).

The owner can turn each link on or off, or reset it. The owner can also set a join password for link users. Members never need it. After one correct password, the client keeps a signed grant (HMAC of the canvas and the password hash). A new password makes old grants invalid. A change to sharing re-checks all connected clients at once: a lost role disconnects them, and a changed role updates their UI. The server rejects ops from viewers. The owner can transfer ownership (the old owner becomes an editor) or delete the canvas.

At load, the server replays the op log to build the document. Limits: 4 MB per message, 20 000 points per stroke, 100 layers per session, 10 new sessions per minute per IP address. The server checks each op for type, range, and size before it accepts the op.

## 9. User interface

The layout is close to Photoshop, but simpler, with a dark theme.

- Top bar: app name, session code with a copy-link button, peer avatars, connection state
- Options bar: the settings of the current tool (size, opacity, flow, hardness, spacing, pressure, build-up). In a narrow window, the bar wraps to a second row. It never cuts off a control.
- Left toolbar: brush (B), eraser (E), eyedropper (I), hand (H), foreground and background colors
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

Phone layout (width under 760 px, or a short touch screen): the canvas fills the screen. A bottom bar holds the tools and three buttons that open bottom sheets: brush settings, color, and layers. A zoom label at the top left resets the zoom to 100%.

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

### 9.1 Pen input

The client reads pens through Pointer Events: `pointerType` "pen", `pressure`, and `getCoalescedEvents()`. The eraser end of a pen (button 5, or bit 32 of `buttons`) always erases, whatever tool is selected.

| Engine | Pen and pressure |
|---|---|
| Chromium (Chrome, Edge, WebView2 in the Windows app) | Yes. On Windows, a Wacom driver must have "Use Windows Ink" on. On Linux with native Wayland, tablet support is not reliable: `--ozone-platform=x11` is a workaround. |
| Firefox | Yes, on Windows and macOS. On Linux, from Firefox 129 (X11 and Wayland). |
| WebKitGTK (the Linux app) | No. Every pointer is a mouse with pressure 0 (WebKit bug 204115). |
| WKWebView and Safari (the macOS app) | No. Pressure comes only from Force Touch trackpads, not from tablets. |

For WebKitGTK and WKWebView, the desktop app reads the pen in the native layer (`src-tauri/src/pen.rs`). On Linux, it connects to the GTK motion and button signals of the WebKitWebView and reads the device source (pen or eraser) and the pressure axis. On macOS, an AppKit local event monitor reads tablet-point and tablet-proximity events. GDK motion compression is off on the web view, so the native layer gets every pen sample. For each sample, it runs `window.__drawPen(pressure, eraser, x, y, kind)` in the page before the engine forwards the same event (x, y in CSS pixels from the top left of the web view; kind: move, press, or release). It runs `__drawPen(null)` when another device moves. The client (`engine/nativePen.ts`) uses these values only for pointer events that the engine reports as a mouse. A stroke from a native pen takes its points from the samples, not from the pointer moves: when the page is busy, WebKit merges pointer moves into one and loses the points and pressures between them. The press sample gives the offset from sample positions to client positions. If a pointer move is not near the recent sample path (24 px), the stroke continues with pointer events.

### 9.2 Files (.bdraw)

- Content: the document as the server sends it in `welcome` (`layers`: Layer[], `strokes`: Stroke[]), plus a header: `format: "bdraw"`, `version: 2` (version 2 can hold adjustment layers, clipping, masks, and brush dynamics; the server reads versions 1 and 2), the app version, the save time, and the source canvas (information only). Deleted layers and erased strokes are not in the file. Type: `src/shared/bdraw.ts`.
- Encoding: gzip-compressed JSON. Plain JSON is also valid. A browser without `CompressionStream` writes plain JSON.
- Save: the save button or `Ctrl+S` writes the confirmed state of the client. A viewer can save too, because a viewer can see the full canvas.
- Open: the open button, `Ctrl+O`, a file dropped on the window, the file manager (desktop app), or the installed PWA (Chromium `file_handlers`). The app always opens the file as a new online canvas with the same create form as the landing page. It never changes the canvas that the file came from.
- Server: `POST /api/import`. The body is the raw file (at most 32 MB, at most 256 MB after gunzip). The create options are URI-encoded JSON in the `X-Draw-Options` header. A cross-site page cannot send this header without a CORS preflight. The server reads and checks the whole file before it makes the canvas. Then it replays each layer and each stroke (in `seq` order) as `layer.add` and `stroke.add` ops, through the same checks as live ops. It skips entries that fail and returns the number it skipped. Strokes keep their IDs and their author.
- Desktop app: the installers register `.bdraw` (`application/x-bdraw`). The `.deb` and `.rpm` packages install a shared-mime-info file in `/usr/share/mime/packages`. The AppImage contains the same file (AppImageLauncher installs it). Gear Lever does not install MIME types, so an AppImage writes the file to `~/.local/share/mime/packages` when it starts (only if it is missing or different) and runs `update-mime-database`. The desktop file has `Exec=draw %F`, so file managers send the paths. The app gets the path as an argument (Windows, Linux) or as `RunEvent::Opened` (macOS). It reads the file with a command that reads only the files the system opened the app with.

Shortcuts: `Ctrl+S` saves a `.bdraw` file, `Ctrl+O` opens one, `Ctrl+0` fits all content, `Ctrl+1` goes to 100%, and `M` shows or hides the markers. `[` and `]` change the size. `Shift+[` and `Shift+]` change the hardness. Keys 1–0 set the opacity. `X` swaps the colors. Hold `Space` to pan. Hold `Alt` for the eyedropper. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo. The mouse wheel zooms at the cursor.

### 9.3 Brush presets

- A preset is brush settings without the tool and the color, with `size` in screen pixels (`BrushSettings`), plus a name. Presets are shared: every person sees every preset.
- Anyone can save a preset, also without an account. The server stores the creator as the account (`owner_id`), or else as the sha256 of the anonymous secret of the browser (`creator_anon`). It shows the creator as `u:<user id>` or `a:<16 hex of the hash>`, never the secret.
- Delete: the creator (the same account, or the same browser) or an admin (`ADMIN_EMAILS`). The server makes the check. The client shows the delete button only for those presets.
- Groups: the panel groups presets by creator, with the account name, or the display name at save time without an account. The own group is first. A group can collapse (the state is kept on the device).
- Thumbnail: the client draws the preset along a squiggle with a pressure curve (light at both ends, full in the middle), with the same dab walker and stamps as real strokes. A large brush is scaled down to fit. Grain is an approximation on the whole stroke. The server stores no images.
- Apply: a click sets the brush (or the eraser, while it is the tool). Settings that the preset does not hold go back to their defaults.
- API: `GET /api/presets`, `POST /api/presets` (`name`, `settings`, `anon`, `creatorName`), `POST /api/presets/<id>/delete` (`anon`). Limits: 30 saves per hour per IP address, 300 presets per creator, 5000 in total.

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

Desktop app on Linux (Electron, `electron/`):

- WebKitGTK (the Tauri engine on Linux) gives pages no pen pressure, merges pointer moves, and with the NVIDIA driver its WebGL is much slower than a browser's. Thus the Linux app is Chromium (Electron). The window shows `https://draw.bsums.xyz` (`DRAW_URL` changes it). Thus the app updates with the server. Only that origin runs in the window. Other links open in the default browser. Without a connection, a local page offers "Try again".
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
- Selection, transform, fill, and text tools
- Export of a region at a chosen resolution, and PSD export

## 12. Risks

- Render time grows with the number of strokes in a tile. Zoomed-out views of dense areas are the worst case. Baked tiles (section 11) fix this.
- A stroke at a coarse LOD can have many dabs smaller than one pixel. The worker clamps the dab size to one pixel and scales its alpha. Thus the look at low zoom is close, but not exact.
- The code is the only protection of a session. Anyone with the link can draw or delete.
