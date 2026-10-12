import { describe, expect, it } from "vitest";
import type { Segment } from "@turbodl/shared";
import {
  MIN_SEGMENT_SIZE,
  insertSegment,
  isSegmentDone,
  planSegments,
  segmentsValid,
  splitLargest,
  totalReceived,
} from "./segments";

const MB = MIN_SEGMENT_SIZE;

describe("planSegments", () => {
  it("splits evenly and covers the whole file", () => {
    const size = 10 * MB + 7;
    const segs = planSegments(size, 8);
    expect(segs).toHaveLength(8);
    expect(segs[0].start).toBe(0);
    expect(segs[7].end).toBe(size - 1);
    expect(segmentsValid(segs, size)).toBe(true);
  });

  it("never makes segments smaller than 1 MB", () => {
    expect(planSegments(2.5 * MB, 8)).toHaveLength(2);
    expect(planSegments(500 * 1024, 8)).toHaveLength(1);
    expect(planSegments(0, 8)).toEqual([]);
  });
});

describe("splitLargest", () => {
  it("splits the remaining part of the busiest segment in half", () => {
    const seg: Segment = { start: 0, end: 9 * MB - 1, received: MB };
    const right = splitLargest([seg], (s) => s.start + s.received);
    expect(right).toEqual({ start: 5 * MB, end: 9 * MB - 1, received: 0 });
    expect(seg.end).toBe(5 * MB - 1);
  });

  it("counts in-flight bytes through the position callback", () => {
    const seg: Segment = { start: 0, end: 9 * MB - 1, received: MB };
    const right = splitLargest([seg], (s) => s.start + s.received + 1000);
    expect(right?.start).toBe(MB + 1000 + Math.floor((8 * MB - 1000) / 2));
  });

  it("picks the segment with the most bytes left", () => {
    const a: Segment = { start: 0, end: 4 * MB - 1, received: 0 };
    const b: Segment = { start: 4 * MB, end: 12 * MB - 1, received: 0 };
    const right = splitLargest([a, b], (s) => s.start + s.received);
    expect(right?.start).toBe(8 * MB);
    expect(b.end).toBe(8 * MB - 1);
    expect(a.end).toBe(4 * MB - 1);
  });

  it("refuses to split small remainders", () => {
    const seg: Segment = { start: 0, end: 3 * MB - 1, received: 2 * MB };
    expect(splitLargest([seg], (s) => s.start + s.received)).toBeNull();
  });
});

describe("helpers", () => {
  it("inserts by start and validates coverage", () => {
    const segs: Segment[] = [
      { start: 0, end: 9, received: 10 },
      { start: 20, end: 29, received: 0 },
    ];
    insertSegment(segs, { start: 10, end: 19, received: 3 });
    expect(segs.map((s) => s.start)).toEqual([0, 10, 20]);
    expect(segmentsValid(segs, 30)).toBe(true);
    expect(segmentsValid(segs, 31)).toBe(false);
    expect(segmentsValid([{ start: 0, end: 9, received: 11 }], 10)).toBe(false);
    expect(segmentsValid([], 10)).toBe(false);
    expect(totalReceived(segs)).toBe(13);
    expect(isSegmentDone(segs[0])).toBe(true);
    expect(isSegmentDone(segs[1])).toBe(false);
  });
});
