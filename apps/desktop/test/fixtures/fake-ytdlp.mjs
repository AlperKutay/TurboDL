// Minimal stand-in for yt-dlp: behaviour is chosen by the URL path (last argument).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const url = args[args.length - 1];
const mode = new URL(url).pathname.slice(1);

if (process.env.PYTHONUTF8 !== "1") {
  console.error("ERROR: PYTHONUTF8 not set");
  process.exit(3);
}
const cookieFile = args.includes("--cookies") ? args[args.indexOf("--cookies") + 1] : null;
if (args.some((a, i) => args[i - 1] === "--add-headers" && /^cookie:/i.test(a))) {
  console.error("ERROR: a Cookie header reached yt-dlp");
  process.exit(4);
}
if (mode === "error") {
  console.error("WARNING: something");
  console.error(`ERROR: [generic] Unsupported URL: ${url}`);
  process.exit(1);
}
if (mode === "login") {
  const jar = cookieFile && existsSync(cookieFile) ? readFileSync(cookieFile, "utf8") : "";
  const signedIn = jar.startsWith("# Netscape HTTP Cookie File") && jar.split("\n").some((l) => l.endsWith("\tsession\tok"));
  if (!signedIn) {
    console.error(
      "ERROR: [youtube] login: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.",
    );
    process.exit(1);
  }
}
// pages on the local test server describe themselves: GET <page>.info.json (the -f selector goes in the query)
if (args.includes("-J") && new URL(url).hostname === "127.0.0.1") {
  const selector = args.includes("-f") ? args[args.indexOf("-f") + 1] : "";
  const res = await fetch(`${url}.info.json?f=${encodeURIComponent(selector)}`);
  if (!res.ok) {
    console.error(`ERROR: [generic] info ${res.status}`);
    process.exit(1);
  }
  console.log(await res.text());
  process.exit(0);
}
if (args.includes("-J")) {
  console.log(JSON.stringify({ title: "Info", formats: [{ height: 720, vcodec: "avc1" }] }));
  process.exit(0);
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
  if (cookieFile) writeFileSync(path.join(path.dirname(file), "cookie-file.txt"), cookieFile);
  console.log(`TDLFILE ${file}`);
  process.exit(0);
}, mode === "slow" ? 50 : mode === "two-parts" ? 20 : 5);
