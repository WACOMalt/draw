import { closeOnBack } from './back';

// Popups (popovers, menus, phone sheets) close when the person presses anywhere outside them,
// presses Escape, or uses Android's Back (back.ts). Use it on the element that holds the popup AND
// the button that opens it, so a press on that button toggles as before:
//
//   <span use:dismiss={{ open, close: () => (open = false) }}>
//
// A press outside on the canvas only closes the popup: it does not paint (see takeDismissed).
// A finger there can still pan, and a second finger pinch-zooms at once.

/** Presses that closed a popup, by pointer id, until that pointer lifts. */
const dismissed = new Set<number>();

for (const t of ['pointerup', 'pointercancel'] as const) {
  // After the engine sees the release (bubble phase, on the window).
  window.addEventListener(t, (e) => dismissed.delete(e.pointerId));
}

/**
 * True when this press closed a popup. The engine calls it on pointerdown: a mouse or pen press
 * then does nothing, a finger only navigates.
 */
export const takeDismissed = (pointerId: number): boolean => dismissed.has(pointerId);

export interface DismissOptions {
  /** Listens only while the popup is open. */
  open: boolean;
  close: () => void;
  /** Presses inside elements that match this selector do not close the popup either. */
  keep?: string;
}

export function dismiss(node: HTMLElement, opts: DismissOptions) {
  let o = opts;
  const down = (e: PointerEvent) => {
    if (!o.open) return;
    const t = e.target as Element | null;
    if (t && (node.contains(t) || (o.keep && t.closest(o.keep)))) return;
    dismissed.add(e.pointerId);
    // A number field in the popup keeps the keyboard otherwise: shortcuts would stay off.
    const a = document.activeElement;
    if (a instanceof HTMLElement && node.contains(a)) a.blur();
    o.close();
  };
  const key = (e: KeyboardEvent) => {
    if (!o.open || e.key !== 'Escape') return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && node.contains(a)) a.blur();
    o.close();
  };
  // Android's Back closes it too, while it is open.
  let release: (() => void) | null = null;
  const track = () => {
    if (o.open && !release) release = closeOnBack(() => o.close());
    else if (!o.open && release) {
      release();
      release = null;
    }
  };
  track();
  // Capture phase: runs before the canvas, which keeps its pointer events to itself.
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('keydown', key);
  return {
    update(next: DismissOptions) {
      o = next;
      track();
    },
    destroy() {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      release?.();
    },
  };
}
