// Starts the unpacked build with a throw-away profile, checks resources and the bridge, then stops it.
// On Linux it also checks the .deb and the AppImage. `--appimage <file>` runs the AppImage checks alone (no release/ needed).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";
const PORT = 47999;
const APPIMAGE_PORT = 48000;
const linux = process.platform === "linux";

let failed = false;
function report(ok, label, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  failed ||= !ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function locate() {
  if (process.platform === "win32") {
    const dir = path.join(release, "win-unpacked");
    return { exe: path.join(dir, "TurboDL.exe"), resources: path.join(dir, "resources") };
  }
  if (linux) {
    const dir = path.join(release, "linux-unpacked");
    return { exe: path.join(dir, "turbodl-app"), resources: path.join(dir, "resources") };
  }
  const macDir = readdirSync(release).find((d) => d.startsWith("mac"));
  if (!macDir) throw new Error("release/mac* not found");
  const app = path.join(release, macDir, "TurboDL.app");
  return { exe: path.join(app, "Contents", "MacOS", "TurboDL"), resources: path.join(app, "Contents", "Resources") };
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/ping", headers: { Origin: ORIGIN } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

/** Runs host.cjs in Node mode with a ping frame; returns the reply text. */
function hostReply(program, hostFile, extraArgs, env) {
  const frame = Buffer.from(JSON.stringify({ type: "ping" }));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(frame.length, 0);
  const res = spawnSync(program, [hostFile, ...extraArgs], {
    input: Buffer.concat([head, frame]),
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 20000,
  });
  const out = res.stdout ?? Buffer.alloc(0);
  const reply = out.length > 4 ? out.subarray(4, 4 + out.readUInt32LE(0)).toString("utf8") : "";
  return { reply, error: res.error };
}

/** Runs turbodl.cjs --version in Node mode; returns the trimmed output. */
function cliVersion(program, cliFile, extraArgs, env) {
  const res = spawnSync(program, [cliFile, ...extraArgs, "--version"], {
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 20000,
  });
  return { out: (res.stdout ?? "").trim(), error: res.error };
}

/** Stops a detached child: SIGTERM to its process group, SIGKILL after 3 s if anything is left. */
async function stopGroup(child) {
  const alive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 6 && alive(); i++) await sleep(500);
  if (alive()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function waitPing(port, tries) {
  let status = 0;
  for (let i = 0; i < tries && status !== 200; i++) {
    await sleep(500);
    status = await ping(port);
  }
  return status;
}

async function appImageChecks(file, version) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-appimage-"));
  let child;
  try {
    let env = {};
    // 1. the resources the AppImage carries
    for (const inner of ["resources/native-host/host.cjs", "resources/cli/turbodl.cjs"]) {
      const res = spawnSync(file, ["--appimage-extract", inner], { cwd: dir, encoding: "utf8", timeout: 120000 });
      if (res.status !== 0 && /fuse/i.test(`${res.stderr}${res.stdout}`)) env = { APPIMAGE_EXTRACT_AND_RUN: "1" };
    }
    const hostFile = path.join(dir, "squashfs-root", "resources", "native-host", "host.cjs");
    const cliFile = path.join(dir, "squashfs-root", "resources", "cli", "turbodl.cjs");
    report(existsSync(hostFile) && existsSync(cliFile), "AppImage contents", "host.cjs and turbodl.cjs under squashfs-root");

    // 2. the browser launcher through the AppImage; a libfuse error here switches the remaining runs to extract-and-run
    let { reply, error } = hostReply(file, hostFile, ["--no-sandbox"], env);
    if (reply !== JSON.stringify({ ok: true }) && !env.APPIMAGE_EXTRACT_AND_RUN) {
      env = { APPIMAGE_EXTRACT_AND_RUN: "1" };
      ({ reply, error } = hostReply(file, hostFile, ["--no-sandbox"], env));
      if (reply === JSON.stringify({ ok: true })) report(true, "AppImage runs extracted", "libfuse is missing, APPIMAGE_EXTRACT_AND_RUN=1");
    } else if (reply === JSON.stringify({ ok: true })) {
      report(true, env.APPIMAGE_EXTRACT_AND_RUN ? "AppImage runs extracted" : "AppImage runs mounted");
    }
    report(reply === JSON.stringify({ ok: true }), "browser launcher answers through the AppImage", reply || error || "no answer");

    // 3. the turbodl command
    const cli = cliVersion(file, cliFile, ["--no-sandbox"], env);
    report(cli.out === `turbodl ${version}`, "turbodl --version through the AppImage", cli.out || cli.error || "no answer");

    // 4. the bridge
    const userData = path.join(dir, "profile");
    mkdirSync(userData);
    writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bridgePort: APPIMAGE_PORT, baseDir: path.join(userData, "dl") }));
    child = spawn(file, ["--hidden", "--no-sandbox"], { env: { ...process.env, ...env, TURBODL_USER_DATA: userData }, stdio: "ignore", detached: true });
    const status = await waitPing(APPIMAGE_PORT, 60);
    report(status === 200, "bridge from the AppImage", `/v1/ping → ${status}`);

    // 5. api.json names the AppImage file
    let launch = null;
    try {
      launch = JSON.parse(readFileSync(path.join(userData, "api.json"), "utf8")).launch;
    } catch {}
    const want = { file: realpathSync(file), args: ["--hidden"] };
    report(JSON.stringify(launch) === JSON.stringify(want), "api.json starts the AppImage file", JSON.stringify(launch));
  } finally {
    // 6. stop
    if (child) await stopGroup(child);
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const appImageArg = argv.indexOf("--appimage");

if (appImageArg >= 0) {
  const file = path.resolve(argv[appImageArg + 1] ?? "");
  const match = /^TurboDL-(.+)-x86_64\.AppImage$/.exec(path.basename(file));
  if (!argv[appImageArg + 1] || !existsSync(file) || !match) {
    console.error("usage: smoke-packaged.mjs --appimage <TurboDL-<version>-x86_64.AppImage>");
    process.exit(2);
  }
  await appImageChecks(file, match[1]);
  process.exit(failed ? 1 : 0);
}

const { exe, resources } = locate();
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const checks = [
  ["app", exe],
  ["ffmpeg", path.join(resources, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")],
  ["extension", path.join(resources, "extension", "manifest.json")],
  ["tray icon", path.join(resources, "icons", process.platform === "darwin" ? "trayTemplate.png" : "tray.png")],
  ["browser launcher", path.join(resources, "native-host", "host.cjs")],
  ["turbodl command", path.join(resources, "cli", "turbodl.cjs")],
  ...(process.platform === "win32" ? [["turbodl command launcher", path.join(resources, "cli", "turbodl.exe")]] : []),
];
for (const [label, file] of checks) report(existsSync(file), label, file);

// the packaged executable must still run host.cjs in Node mode (ELECTRON_RUN_AS_NODE fuse)
{
  const { reply, error } = hostReply(exe, path.join(resources, "native-host", "host.cjs"), [], {});
  report(reply === JSON.stringify({ ok: true }), "browser launcher answers in Node mode", reply || error || "no answer");
}

// the packaged executable must run the turbodl command in Node mode, and report this build's version
{
  const { out, error } = cliVersion(exe, path.join(resources, "cli", "turbodl.cjs"), [], {});
  report(out === `turbodl ${version}`, "turbodl --version in Node mode", out || error || "no answer");
}

if (linux) {
  const debName = `TurboDL-${version}-amd64.deb`;
  const imageName = `TurboDL-${version}-x86_64.AppImage`;
  const deb = path.join(release, debName);
  const image = path.join(release, imageName);
  report(existsSync(deb), "deb package", debName);
  report(existsSync(image), "AppImage", imageName);

  const ffmpeg = spawnSync(path.join(resources, "ffmpeg", "ffmpeg"), ["-version"], { encoding: "utf8", timeout: 20000 });
  report(ffmpeg.status === 0, "ffmpeg runs", (ffmpeg.stdout ?? "").split("\n")[0] || ffmpeg.error);

  if (existsSync(deb)) {
    const pkg = spawnSync("dpkg-deb", ["-f", deb, "Package"], { encoding: "utf8" });
    const list = spawnSync("dpkg-deb", ["-c", deb], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const names = (list.stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/).slice(5).join(" ").split(" -> ")[0]);
    const wanted = ["./opt/TurboDL/turbodl-app", "./opt/TurboDL/resources/cli/turbodl.cjs", "./usr/share/applications/turbodl-app.desktop"];
    const missing = wanted.filter((w) => !names.includes(w));
    const name = (pkg.stdout ?? "").trim();
    report(name === "turbodl" && missing.length === 0, "deb contents", name !== "turbodl" ? `Package is "${name}"` : missing.length ? `missing ${missing.join(", ")}` : "turbodl-app, turbodl.cjs, desktop entry");
  }
}

const userData = mkdtempSync(path.join(os.tmpdir(), "turbodl-packaged-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bridgePort: PORT, baseDir: path.join(userData, "dl") }));
const child = spawn(exe, linux ? ["--hidden", "--no-sandbox"] : ["--hidden"], {
  env: { ...process.env, TURBODL_USER_DATA: userData },
  stdio: "ignore",
  detached: linux,
});

const status = await waitPing(PORT, 60);
report(status === 200, "bridge /v1/ping", `→ ${status}`);

if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
else if (linux) await stopGroup(child);
else child.kill("SIGTERM");
await sleep(1000);
rmSync(userData, { recursive: true, force: true });

if (linux && existsSync(path.join(release, `TurboDL-${version}-x86_64.AppImage`))) {
  await appImageChecks(path.join(release, `TurboDL-${version}-x86_64.AppImage`), version);
}
process.exit(failed ? 1 : 0);
