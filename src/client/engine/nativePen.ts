// Pen data from the desktop app's native layer (src-tauri/src/pen.rs), for engines that report
// a tablet pen as a mouse without pressure: WebKitGTK (Linux) and WKWebView (macOS).
// For each pen event the native side calls window.__drawPen(pressure, eraser) just before the
// engine sends the page the same event. It calls __drawPen(null) when another device moves.
// Browsers and WebView2 (Windows) report pens themselves and never call it.

export interface NativePen {
  pressure: number; // 0..1
  eraser: boolean; // the eraser end of the pen
}

let current: NativePen | null = null;

(window as unknown as { __drawPen: (p: number | null, eraser: boolean) => void }).__drawPen = (p, eraser) => {
  current = typeof p === 'number' && Number.isFinite(p) ? { pressure: Math.min(1, Math.max(0, p)), eraser: !!eraser } : null;
};

/** The pen behind a pointer event that the engine reported as a mouse, or null. */
export function nativePenFor(e: PointerEvent): NativePen | null {
  return e.pointerType === 'mouse' ? current : null;
}
