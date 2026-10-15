// Firefox flavour of the extension manifest (used by build.mjs; keep the id in sync with FIREFOX_EXTENSION_ID).
export const GECKO_ID = "turbodl@turbodl.app";

/** Firefox runs background scripts instead of a service worker and identifies add-ons by gecko id. */
export function firefoxManifest(chromeManifest) {
  const m = structuredClone(chromeManifest);
  delete m.key;
  delete m.minimum_chrome_version;
  m.background = { scripts: ["background.js"] };
  m.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
  };
  return m;
}
