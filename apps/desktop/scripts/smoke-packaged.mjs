// Starts the unpacked build with a throw-away profile, checks resources and the bridge, then stops it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";
const PORT = 47999;

function locate() {
  if (process.platform === "win32") {
    const dir = path.join(release, "win-unpacked");
    return { exe: path.join(dir, "TurboDL.exe"), resources: path.join(dir, "resources") };
  }
  const macDir = readdirSync(release).find((d) => d.startsWith("mac"));
  if (!macDir) throw new Error("release/mac* not found");
  const app = path.join(release, macDir, "TurboDL.app");
  return { exe: path.join(app, "Contents", "MacOS", "TurboDL"), resources: path.join(app, "Contents", "Resources") };
}

function ping() {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/ping", headers: { Origin: ORIGIN } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

const { exe, resources } = locate();
const checks = [
  ["app", exe],
  ["ffmpeg", path.join(resources, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")],
  ["extension", path.join(resources, "extension", "manifest.json")],
  ["tray icon", path.join(resources, "icons", process.platform === "darwin" ? "trayTemplate.png" : "tray.png")],
];
let failed = false;
for (const [label, file] of checks) {
  const ok = existsSync(file);
  console.log(`${ok ? "✓" : "✗"} ${label}: ${file}`);
  failed ||= !ok;
}

const userData = mkdtempSync(path.join(os.tmpdir(), "turbodl-packaged-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bridgePort: PORT, baseDir: path.join(userData, "dl") }));
const child = spawn(exe, ["--hidden"], { env: { ...process.env, TURBODL_USER_DATA: userData }, stdio: "ignore" });

let status = 0;
for (let i = 0; i < 60 && status !== 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  status = await ping();
}
console.log(`${status === 200 ? "✓" : "✗"} bridge /v1/ping → ${status}`);
failed ||= status !== 200;

if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
else child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1000));
rmSync(userData, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
