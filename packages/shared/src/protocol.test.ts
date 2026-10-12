import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_PORT, EXTENSION_ID, EXTENSION_ORIGIN } from "./index";

describe("protocol constants", () => {
  it("pins a valid Chrome extension id", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });

  it("uses an unprivileged loopback port", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(47123);
  });
});
