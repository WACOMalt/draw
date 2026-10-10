// Canvases on this device from .bdraw files: read on the device (no server), then filled through
// the same checks as the server's import (shared/docState.ts importOps).

import { BDRAW_VERSION, isGzip, type BdrawFile } from '../../shared/bdraw';
import { DocState, importOps } from '../../shared/docState';
import { createLocal, appendOps, deleteLocal, type StoredOp } from './store';

/** A new canvas's name: the date and time, as "Drawing, 10 Oct 14:32". */
export function defaultName(): string {
  const d = new Date();
  return `Drawing, ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Reads a .bdraw file (gzip or plain JSON). Throws an Error with a message for people. */
export async function readBdraw(blob: Blob): Promise<BdrawFile> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text: string;
  try {
    if (isGzip(bytes)) {
      if (typeof DecompressionStream === 'undefined') throw new Error('gzip');
      text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = new TextDecoder().decode(bytes);
  } catch {
    throw new Error('This file cannot be read here. Open it in a newer browser or in the Draw app.');
  }
  let file: BdrawFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('This is not a Draw file, or it is damaged.');
  }
  if (!file || file.format !== 'bdraw' || !Array.isArray(file.layers) || !Array.isArray(file.strokes)) throw new Error('This is not a Draw file, or it is damaged.');
  if (typeof file.version !== 'number' || file.version > BDRAW_VERSION) throw new Error('This file is from a newer Draw. Update the app.');
  return file;
}

/** A canvas on this device from a .bdraw file. Returns its id and how many items were left out. */
export async function createLocalFromFile(name: string, blob: Blob): Promise<{ id: string; skipped: number }> {
  const file = await readBdraw(blob);
  const c = await createLocal(name);
  const doc = new DocState();
  const ops: StoredOp[] = [];
  const n = importOps(doc, file.layers, file.strokes, file.shapes ?? [], (op, by) => {
    const seq = ops.length + 1;
    const applied = doc.apply(op, by, seq);
    ops.push({ canvas: c.id, seq, by, op: applied });
  });
  try {
    await appendOps(c.id, ops);
  } catch (e) {
    await deleteLocal(c.id).catch(() => {});
    throw new Error(`The device's storage for Draw failed (${e instanceof Error ? e.message : 'unknown'}).`);
  }
  return { id: c.id, skipped: n.skipped };
}
