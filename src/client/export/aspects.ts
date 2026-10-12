// The shapes the export offers (width : height), shared by the export dialog and the region
// picker on the canvas.

export const ASPECTS: [id: string, w: number, h: number][] = [
  ['1:1', 1, 1],
  ['4:3', 4, 3],
  ['3:2', 3, 2],
  ['16:9', 16, 9],
  ['21:9', 21, 9],
  ['4:5', 4, 5],
  ['2:3', 2, 3],
  ['9:16', 9, 16],
];

/** Width / height of an aspect id, or null when it is not one of ASPECTS. */
export function aspectRatio(id: string | null): number | null {
  const a = ASPECTS.find(([x]) => x === id);
  return a ? a[1] / a[2] : null;
}
