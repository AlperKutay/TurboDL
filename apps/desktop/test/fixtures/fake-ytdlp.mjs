// Minimal stand-in for yt-dlp: behaviour is chosen by the URL path (last argument).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const url = args[args.length - 1];
const mode = new URL(url).pathname.slice(1);

if (process.env.PYTHONUTF8 !== "1") {
  console.error("ERROR: PYTHONUTF8 not set");
  process.exit(3);
}
if (args.includes("-J")) {
  console.log(JSON.stringify({ title: "Info", formats: [{ height: 720, vcodec: "avc1" }] }));
  process.exit(0);
}
if (mode === "error") {
  console.error("WARNING: something");
  console.error(`ERROR: [generic] Unsupported URL: ${url}`);
  process.exit(1);
}

const template = args[args.indexOf("-o") + 1];
const file = template.replace("%(title).150B", "Vidéo Zoë").replace("%(ext)s", "mp4");
const parts = mode === "two-parts" ? 2 : 1;
const total = 1000;
const steps = mode === "slow" ? 400 : 4;
let part = 0;
let step = 0;
const timer = setInterval(() => {
  step++;
  const done = Math.round((total * step) / steps);
  console.log(`TDLPROG ${done} ${total} NA ${100 * step} ${steps - step}`);
  if (step < steps) return;
  part++;
  step = 0;
  if (part < parts) return;
  clearInterval(timer);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(1500));
  console.log(`TDLFILE ${file}`);
  process.exit(0);
}, mode === "slow" ? 50 : mode === "two-parts" ? 20 : 5);
