import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIREFOX_EXTENSION_ID } from "@turbodl/shared";
import { firefoxManifest } from "../firefox.mjs";

const chromeManifest = JSON.parse(readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

describe("firefoxManifest", () => {
  it("turns the Chrome manifest into a Firefox one", () => {
    const m = firefoxManifest(chromeManifest);
    expect(m).not.toHaveProperty("key");
    expect(m).not.toHaveProperty("minimum_chrome_version");
    // Firefox runs background scripts, not a service worker
    expect(m.background).toEqual({ scripts: ["background.js"] });
    expect(m.browser_specific_settings).toEqual({
      gecko: { id: FIREFOX_EXTENSION_ID, strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
    });
    for (const field of ["manifest_version", "name", "version", "description", "permissions", "host_permissions", "content_scripts", "action", "icons"]) {
      expect(m[field]).toEqual(chromeManifest[field]);
    }
  });

  it("leaves the Chrome manifest as it was", () => {
    const copy = structuredClone(chromeManifest);
    firefoxManifest(copy);
    expect(copy).toEqual(chromeManifest);
  });
});
