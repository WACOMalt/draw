import { mount } from 'svelte';
import App from './App.svelte';
import Embed from './ui/Embed.svelte';
import './app.css';
import { BUNDLED } from './config';
import { parseKey } from '../shared/types';
import { parseFrame } from './embed';

// /e/CODE is an embed on another site: only the drawing, no app around it.
const embed = /^\/e\/([^/]+)\/?$/.exec(location.pathname);
let embedKey: string | null = null;
try {
  embedKey = embed ? parseKey(decodeURIComponent(embed[1])) : null;
} catch {
  embedKey = null;
}
if (embedKey) {
  // Let the wheel and touch scrolling pass on to the page around the embed (app.css stops it
  // for the full app).
  document.documentElement.style.overscrollBehavior = document.body.style.overscrollBehavior = 'auto';
  const frame = parseFrame(new URLSearchParams(location.search).get('r')) ?? { x0: -640, y0: -360, x1: 640, y1: 360 };
  mount(Embed, { target: document.getElementById('app')!, props: { code: embedKey, frame } });
} else mount(App, { target: document.getElementById('app')! });

// The service worker makes the app installable (Chrome, Edge, Firefox for Android).
// Only in production builds: in dev it would cache Vite's modules.
if (import.meta.env.PROD && !BUNDLED && !embedKey && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e));
  });
}
