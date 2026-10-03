// Canvases this browser opened recently. Per-device convenience only; never a source of truth.

export interface Recent {
  key: string;
  t: number;
}

const KEY = 'draw.recent';
const MAX = 12;

export function loadRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => typeof r?.key === 'string' && typeof r?.t === 'number') : [];
  } catch {
    return [];
  }
}

function save(list: Recent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // storage unavailable
  }
}

export function addRecent(key: string): void {
  save([{ key, t: Date.now() }, ...loadRecent().filter((r) => r.key !== key)]);
}

export function removeRecent(key: string): void {
  save(loadRecent().filter((r) => r.key !== key));
}
