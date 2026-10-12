import type { Segment } from "@turbodl/shared";

export const MIN_SEGMENT_SIZE = 1024 * 1024;
export const MIN_SPLIT_REMAINING = 2 * MIN_SEGMENT_SIZE;

export function planSegments(size: number, connections: number): Segment[] {
  if (size <= 0) return [];
  const count = Math.max(1, Math.min(connections, Math.floor(size / MIN_SEGMENT_SIZE)));
  const base = Math.floor(size / count);
  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * base;
    const end = i === count - 1 ? size - 1 : start + base - 1;
    segments.push({ start, end, received: 0 });
  }
  return segments;
}

export function segmentLength(s: Segment): number {
  return s.end - s.start + 1;
}

export function isSegmentDone(s: Segment): boolean {
  return s.received >= segmentLength(s);
}

export function totalReceived(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + Math.min(s.received, segmentLength(s)), 0);
}

/**
 * Split the active segment with the most bytes left. `position(seg)` is the next
 * byte its worker will write (including bytes currently being written).
 * Shrinks the chosen segment and returns the new right-hand segment.
 */
export function splitLargest(
  active: Segment[],
  position: (s: Segment) => number,
  minRemaining = MIN_SPLIT_REMAINING,
): Segment | null {
  let best: Segment | null = null;
  let bestLeft = 0;
  for (const s of active) {
    const left = s.end - position(s) + 1;
    if (left >= minRemaining && left > bestLeft) {
      best = s;
      bestLeft = left;
    }
  }
  if (!best) return null;
  const mid = position(best) + Math.floor(bestLeft / 2);
  const right: Segment = { start: mid, end: best.end, received: 0 };
  best.end = mid - 1;
  return right;
}

export function insertSegment(segments: Segment[], seg: Segment): void {
  const index = segments.findIndex((s) => s.start > seg.start);
  if (index === -1) segments.push(seg);
  else segments.splice(index, 0, seg);
}

/** Ordered, contiguous, covering [0, size) with sane counters. */
export function segmentsValid(segments: Segment[], size: number): boolean {
  if (segments.length === 0) return false;
  let expected = 0;
  for (const s of segments) {
    if (s.start !== expected || s.end < s.start || s.received < 0 || s.received > segmentLength(s)) return false;
    expected = s.end + 1;
  }
  return expected === size;
}
