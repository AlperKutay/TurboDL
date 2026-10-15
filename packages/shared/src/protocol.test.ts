import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_PORT, EXTENSION_ID, EXTENSION_ORIGIN, FIREFOX_EXTENSION_ID, isFirefoxExtensionOrigin } from "./index";

describe("protocol constants", () => {
  it("pins a valid Chrome extension id", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });

  it("names the Firefox build with an email-style add-on id", () => {
    expect(FIREFOX_EXTENSION_ID).toBe("turbodl@turbodl.app");
  });

  it("recognises Firefox extension origins, whose id part is random per profile", () => {
    expect(isFirefoxExtensionOrigin("moz-extension://11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isFirefoxExtensionOrigin("moz-extension://ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
    expect(isFirefoxExtensionOrigin("moz-extension://evil.example")).toBe(false);
    expect(isFirefoxExtensionOrigin("https://11111111-2222-3333-4444-555555555555.example")).toBe(false);
    expect(isFirefoxExtensionOrigin("moz-extension://11111111-2222-3333-4444-555555555555/")).toBe(false);
    expect(isFirefoxExtensionOrigin(undefined)).toBe(false);
  });

  it("uses an unprivileged loopback port", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(47123);
  });
});
