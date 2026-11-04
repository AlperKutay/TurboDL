import path from "node:path";
import { describe, expect, it } from "vitest";
import { highlightsFolder, taggedFolder } from "../../src/main/instagram/folders";

const BASE = path.join("base");

describe("Instagram folders", () => {
  it("puts a profile's tagged posts beside its folder when downloads aren't kept per account", () => {
    expect(taggedFolder(BASE, "a", false)).toBe(path.join(BASE, "Instagram", "a · Tagged"));
  });

  it("puts a profile's tagged posts under its folder when downloads are kept per account", () => {
    expect(taggedFolder(BASE, "a", true)).toBe(path.join(BASE, "Instagram", "a", "Tagged"));
  });

  it("keeps highlights and tagged posts apart", () => {
    expect(taggedFolder(BASE, "a", true)).not.toBe(highlightsFolder(BASE, "a", true));
    expect(taggedFolder(BASE, "a", false)).not.toBe(highlightsFolder(BASE, "a", false));
  });
});
