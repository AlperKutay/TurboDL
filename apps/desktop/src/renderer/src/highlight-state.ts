/** Highlight ids in the order they were picked; picking one again takes it out. */
export function togglePick(picked: string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

/** The next picked highlight to read after `loaded` of them ("Loading highlight index of total…"), or null when all are read. */
export function nextLoad(picked: string[], loaded: number): { id: string; index: number; total: number } | null {
  const id = picked[loaded];
  return id === undefined ? null : { id, index: loaded + 1, total: picked.length };
}
