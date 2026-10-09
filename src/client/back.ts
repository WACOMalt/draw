// Android's Back (and a browser's back button) closes the top popup: a bottom sheet, a menu, a
// dialog. Without this, Back left the canvas for the start page, and coming back loaded the whole
// canvas again.
//
// While anything is open, one history entry (state { drawPopup: true }) sits on top of the page's
// own. Back pops that entry: the newest popup closes, and when others are still open the entry
// comes back. A popup closed another way (its X, a press outside) removes the entry with
// history.back(), unless another popup opened in the same moment (switching sheets).

interface Open {
  close: () => void;
}

const open: Open[] = [];
let hasEntry = false;
/** Our own history.back() calls: their popstate is not a Back press. */
let ownPops = 0;
let settle = 0;

function pushEntry(): void {
  history.pushState({ ...(history.state ?? {}), drawPopup: true }, '');
  hasEntry = true;
}

/**
 * Call when a popup opens. `close` closes it (Back pressed). Returns the function to call when
 * it closes another way.
 */
export function closeOnBack(close: () => void): () => void {
  const entry: Open = { close };
  open.push(entry);
  if (!hasEntry) pushEntry();
  return () => {
    const i = open.indexOf(entry);
    if (i < 0) return; // Back closed it
    open.splice(i, 1);
    window.clearTimeout(settle);
    // Wait a moment: a sheet switch closes one and opens the next, which keeps the entry.
    settle = window.setTimeout(() => {
      if (open.length || !hasEntry) return;
      hasEntry = false;
      if (history.state?.drawPopup) {
        ownPops++;
        history.back();
      }
    }, 0);
  };
}

// Capture phase on window: before the app's own popstate handler (App.svelte).
window.addEventListener(
  'popstate',
  (e) => {
    if (ownPops) {
      ownPops--;
      e.stopImmediatePropagation();
      return;
    }
    if (!hasEntry) return; // a page navigation
    hasEntry = false;
    const top = open.pop();
    if (!top) return;
    e.stopImmediatePropagation();
    top.close();
    if (open.length) pushEntry();
  },
  true,
);
