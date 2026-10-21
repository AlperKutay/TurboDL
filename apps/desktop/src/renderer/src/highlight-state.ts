import type { HighlightResult } from "@turbodl/shared";

/** Highlight ids in the order they were picked; picking one again takes it out. */
export function togglePick(picked: string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

/** The next picked highlight to read after `loaded` of them ("Loading highlight index of total…"), or null when all are read. */
export function nextLoad(picked: string[], loaded: number): { id: string; index: number; total: number } | null {
  const id = picked[loaded];
  return id === undefined ? null : { id, index: loaded + 1, total: picked.length };
}

/**
 * Reads the picked highlights one at a time, in pick order, through `load`: "read" when every one was read (those
 * that showed nothing included), or what stopped it — Instagram's sign-in page or its slow down, or the reading being
 * called off (`stillWanted` false: Cancel, a newer Next, the screen gone), after which no answer counts.
 */
export async function readHighlights(
  picked: string[],
  load: (id: string) => Promise<HighlightResult>,
  o: { stillWanted(): boolean; onProgress(index: number, total: number): void },
): Promise<"read" | "signedOut" | "rateLimited" | "cancelled"> {
  for (let loaded = 0; ; loaded++) {
    const step = nextLoad(picked, loaded);
    if (!step) return "read";
    if (!o.stillWanted()) return "cancelled";
    o.onProgress(step.index, step.total);
    const res = await load(step.id);
    if (!o.stillWanted()) return "cancelled";
    if (res.type === "signedOut" || res.type === "rateLimited") return res.type;
  }
}
