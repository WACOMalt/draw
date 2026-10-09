// The Linux app's thumbnailer page (thumb.html, built into electron/thumb). The app loads it in
// a hidden window for `draw --thumbnail IN OUT SIZE` and calls renderBdraw: it renders a .bdraw
// file that has no stored preview (files saved before Draw 0.2.24) with the same off-screen
// WebGL2 renderer as the image export, and returns a PNG.

import { isGzip, type BdrawFile } from '../shared/bdraw';
import { Doc } from './engine/doc';
import { effectivelyDeleted, effectivelyVisible } from '../shared/layers';
import { unionAll } from './engine/navigator';
import { padded, renderPng } from './export/region';

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (!isGzip(bytes)) return new TextDecoder().decode(bytes);
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

/** base64 of the file in, base64 of a PNG of at most size × size out (null: nothing drawn). */
async function renderBdraw(fileB64: string, size: number): Promise<string | null> {
  const bytes = Uint8Array.from(atob(fileB64), (c) => c.charCodeAt(0));
  const file = JSON.parse(await gunzip(bytes)) as BdrawFile;
  if (file.format !== 'bdraw' || !Array.isArray(file.layers) || !Array.isArray(file.strokes)) throw new Error('not a .bdraw file');
  const seq = file.strokes.reduce((m, s) => Math.max(m, s.seq ?? 0), 0);
  const shapes = Array.isArray(file.shapes) ? file.shapes : [];
  const doc = new Doc();
  doc.reset(seq, file.layers, file.strokes, shapes);
  const byId = new Map(file.layers.map((l) => [l.id, l]));
  const visible = new Set(file.layers.filter((l) => !effectivelyDeleted(byId, l) && effectivelyVisible(byId, l)).map((l) => l.id));
  const all = unionAll(doc, visible);
  if (!all) return null;
  const png = await renderPng(doc.displayLayers(), file.strokes, seq, padded(all, 0.04), size, size, shapes);
  if (!png) return null;
  const buf = new Uint8Array(await png.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

(window as unknown as { renderBdraw: typeof renderBdraw }).renderBdraw = renderBdraw;
