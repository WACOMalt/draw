// Pen data from the desktop app's native layer (src-tauri/src/pen.rs), for engines that report
// a tablet pen as a mouse without pressure: WebKitGTK (Linux) and WKWebView (macOS).
// For each pen sample the native side calls window.__drawPen(pressure, eraser, x, y, kind)
// just before the engine sends the page the same event: x, y in CSS pixels from the top left
// of the web view, kind 0 move, 1 press, 2 release. It calls __drawPen(null) when another
// device moves. Browsers and WebView2 (Windows) report pens themselves and never call it.
//
// A stroke takes its points from these samples, not from the engine's pointer moves: while the
// page is busy, WebKit merges pointer moves and loses the points (and pressures) in between.

export interface NativePen {
  pressure: number; // 0..1
  eraser: boolean; // the eraser end of the pen
}

export interface PenSample {
  x: number;
  y: number;
  pressure: number;
  kind: 0 | 1 | 2;
}

let current: NativePen | null = null;
const queue: PenSample[] = [];

(window as unknown as { __drawPen: (p: number | null, eraser: boolean, x?: number, y?: number, kind?: number) => void }).__drawPen = (
  p,
  eraser,
  x,
  y,
  kind,
) => {
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    current = null;
    queue.length = 0;
    return;
  }
  const pressure = Math.min(1, Math.max(0, p));
  current = { pressure, eraser: !!eraser };
  if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
    queue.push({ x, y, pressure, kind: kind === 1 ? 1 : kind === 2 ? 2 : 0 });
    if (queue.length > 4000) queue.splice(0, 2000); // hovering without drawing for a long time
  }
};

/** The pen behind a pointer event that the engine reported as a mouse, or null. */
export function nativePenFor(e: PointerEvent): NativePen | null {
  return e.pointerType === 'mouse' ? current : null;
}

/** The samples that arrived since the last call, oldest first. */
export function takePenSamples(): PenSample[] {
  return queue.splice(0);
}
