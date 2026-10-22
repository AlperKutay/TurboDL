import { describe, expect, it } from "vitest";
import { chromeAgent } from "../../src/main/instagram/agent";

describe("chromeAgent", () => {
  it("drops Electron's and the app's own tokens, leaving Chrome's", () => {
    const electron =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @turbodl/desktop/0.4.0 Chrome/146.0.7680.65 Electron/44.7.0 Safari/537.36";
    expect(chromeAgent(electron)).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.65 Safari/537.36");
    expect(chromeAgent(electron.replace("@turbodl/desktop", "TurboDL"))).not.toMatch(/TurboDL|Electron/);
  });

  it("leaves a plain Chrome agent as it is", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
    expect(chromeAgent(chrome)).toBe(chrome);
  });
});
