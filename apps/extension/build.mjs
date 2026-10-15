import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { firefoxManifest } from "./firefox.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));

/** dist/ for Chromium browsers (service worker), dist-firefox/ for Firefox (background script). */
const flavours = [
  { out: path.join(root, "dist"), target: "chrome120", backgroundFormat: "esm", manifest },
  { out: path.join(root, "dist-firefox"), target: "firefox140", backgroundFormat: "iife", manifest: firefoxManifest(manifest) },
];

for (const f of flavours) {
  rmSync(f.out, { recursive: true, force: true });
  mkdirSync(f.out, { recursive: true });
  const common = { bundle: true, target: f.target, logLevel: "info", charset: "utf8" };
  await build({ ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(f.out, "background.js"), format: f.backgroundFormat });
  await build({ ...common, entryPoints: [path.join(root, "src/content.ts")], outfile: path.join(f.out, "content.js"), format: "iife" });
  await build({ ...common, entryPoints: [path.join(root, "src/popup.ts")], outfile: path.join(f.out, "popup.js"), format: "iife" });
  writeFileSync(path.join(f.out, "manifest.json"), `${JSON.stringify(f.manifest, null, 2)}\n`);
  cpSync(path.join(root, "src/popup.html"), path.join(f.out, "popup.html"));
  cpSync(path.join(root, "src/popup.css"), path.join(f.out, "popup.css"));
  cpSync(path.join(root, "icons"), path.join(f.out, "icons"), { recursive: true });
  console.log(`Extension ready: ${f.out}`);
}
