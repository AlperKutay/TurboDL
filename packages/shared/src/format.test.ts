import { describe, expect, it } from "vitest";
import { STATUS_LABELS, formatBytes, formatDuration, formatPercent, formatSpeed } from "./index";

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(null)).toBe("—");
  });
});

describe("formatSpeed / formatDuration / formatPercent", () => {
  it("formats speed", () => {
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(2048)).toBe("2.0 KB/s");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(125)).toBe("2 min 5 s");
    expect(formatDuration(3700)).toBe("1 h 1 min");
    expect(formatDuration(90000)).toBe("1 d 1 h");
    expect(formatDuration(null)).toBe("—");
  });

  it("formats percentages", () => {
    expect(formatPercent(50, 200)).toBe("25%");
    expect(formatPercent(1, null)).toBe("—");
  });

  it("labels statuses", () => {
    expect(STATUS_LABELS.downloading).toBe("Downloading");
    expect(STATUS_LABELS.scheduled).toBe("Scheduled");
  });
});
