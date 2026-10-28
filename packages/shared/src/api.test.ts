import { describe, expect, it } from "vitest";
import { parseIsoTime } from "./api";

describe("parseIsoTime", () => {
  it.each([
    ["2026-10-01", "2026-10-01T00:00:00.000Z"],
    ["2026-10-01T12:30Z", "2026-10-01T12:30:00.000Z"],
    ["2026-10-01T12:30:15.5+03:00", "2026-10-01T09:30:15.500Z"],
  ])("accepts %s", (input, expected) => {
    expect(parseIsoTime(input)).toBe(expected);
  });

  it.each(["1", "2026", "October 1", "1/2/2026", "2026-01-01T00:00:00", "2026-13-01", "2026-02-30", "2026-02-30T10:00Z", ""])(
    "rejects %j",
    (input) => {
      expect(parseIsoTime(input)).toBeUndefined();
    },
  );
});
