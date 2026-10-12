import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, target: "chrome120", logLevel: "info", charset: "utf8" };
await build({ ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(out, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [path.join(root, "src/content.ts")], outfile: path.join(out, "content.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/popup.ts")], outfile: path.join(out, "popup.js"), format: "iife" });

cpSync(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
cpSync(path.join(root, "src/popup.html"), path.join(out, "popup.html"));
cpSync(path.join(root, "src/popup.css"), path.join(out, "popup.css"));
cpSync(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });
console.log(`Extension ready: ${out}`);
