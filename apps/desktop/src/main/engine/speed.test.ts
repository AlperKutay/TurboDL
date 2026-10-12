import { describe, expect, it } from "vitest";
import { SpeedMeter, estimateEta } from "./speed";

describe("SpeedMeter", () => {
  it("averages over the elapsed time (at least one second)", () => {
    let t = 0;
    const meter = new SpeedMeter(5000, () => t);
    meter.add(1000);
    t = 500;
    meter.add(1000);
    expect(meter.bytesPerSecond).toBe(2000);
    t = 2000;
    meter.add(2000);
    expect(meter.bytesPerSecond).toBe(2000);
  });

  it("forgets samples outside the window", () => {
    let t = 0;
    const meter = new SpeedMeter(5000, () => t);
    meter.add(10_000);
    t = 6000;
    expect(meter.bytesPerSecond).toBe(0);
  });

  it("resets", () => {
    let t = 0;
    const meter = new SpeedMeter(5000, () => t);
    meter.add(5000);
    meter.reset();
    expect(meter.bytesPerSecond).toBe(0);
  });
});

describe("estimateEta", () => {
  it("divides remaining bytes by speed", () => {
    expect(estimateEta(1000, 100)).toBe(10);
    expect(estimateEta(null, 100)).toBeNull();
    expect(estimateEta(1000, 0)).toBeNull();
  });
});
