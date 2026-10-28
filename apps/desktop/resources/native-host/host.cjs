// Native messaging host for the TurboDL browser extension.
// The browser starts it through a launcher (turbodl-host.bat / turbodl-host.sh) that runs the
// TurboDL executable with ELECTRON_RUN_AS_NODE=1, so no separate binary ships with the app.
// It answers exactly one message and exits; "launch" starts TurboDL in the background.
"use strict";
const { spawn } = require("node:child_process");

const MAX_MESSAGE = 1024 * 1024;
const IDLE_MS = 5000;

/** @param {unknown} message */
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * The first length-prefixed (little-endian uint32) JSON message in buf.
 * @param {Buffer} buf
 */
function decode(buf) {
  if (buf.length < 4) return { done: false };
  const length = buf.readUInt32LE(0);
  if (length > MAX_MESSAGE) return { done: true, error: "too large" };
  if (buf.length < 4 + length) return { done: false };
  try {
    return { done: true, message: JSON.parse(buf.subarray(4, 4 + length).toString("utf8")) };
  } catch {
    return { done: true, error: "json" };
  }
}

/**
 * How to start TurboDL from the host process.
 * @param {string} platform
 * @param {string} execPath the TurboDL executable (the host runs inside it in Node mode)
 * @param {string[]} launchArgs extra arguments before --hidden (development and tests)
 * @param {Record<string, string | undefined>} [env] the host's environment (the AppImage rule below)
 */
function launchSpec(platform, execPath, launchArgs, env = {}) {
  // Linux AppImage: its /tmp/.mount_* folder goes away when the host exits, so start the AppImage file.
  // Keep in sync with appLocation in src/main/app-location.ts (this file cannot import it).
  if (platform === "linux" && env.APPIMAGE && env.APPDIR && execPath.startsWith(`${env.APPDIR}/`)) {
    return { file: env.APPIMAGE, args: [...launchArgs, "--hidden"] };
  }
  const bundle = platform === "darwin" ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath) : null;
  // `open` hands the app to launchd, so it outlives the browser and this host
  if (bundle) return { file: "open", args: ["-g", "-a", bundle[1], "--args", "--hidden"] };
  return { file: execPath, args: [...launchArgs, "--hidden"] };
}

/** @param {string[]} argv */
function launchArgsFrom(argv) {
  return argv.filter((a) => a.startsWith("--launch-arg=")).map((a) => a.slice("--launch-arg=".length));
}

/** The lists AppRun puts the AppImage's mount into, and the variables it adds itself. */
const APPRUN_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];
const APPRUN_MARKERS = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/**
 * The environment for the TurboDL this host starts: a copy without ELECTRON_RUN_AS_NODE. With APPDIR non-empty (the host
 * runs from an AppImage), also without AppRun's markers and without every `:`-separated entry of APPRUN_LISTS that is
 * APPDIR or under it (a list left empty is removed): the mount goes away when this host exits, and another user could then
 * create a folder there.
 * Keep in sync with launchEnv in src/main/app-location.ts (this file cannot import it).
 * @param {Record<string, string | undefined>} env
 */
function launchEnv(env) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  const dir = env.APPDIR;
  if (!dir) return out;
  for (const name of APPRUN_LISTS) {
    const value = out[name];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((entry) => entry !== dir && !entry.startsWith(`${dir}/`))
      .join(":");
    if (kept) out[name] = kept;
    else delete out[name];
  }
  for (const name of APPRUN_MARKERS) delete out[name];
  return out;
}

function launch() {
  // launchSpec reads the AppImage variables that launchEnv removes
  const spec = launchSpec(process.platform, process.execPath, launchArgsFrom(process.argv), process.env);
  const env = launchEnv(process.env);
  return new Promise((resolve) => {
    // stdio "ignore": the app must not hold on to the browser's messaging pipes
    const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore", env });
    child.once("error", (err) => resolve({ ok: false, error: err.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

/** @param {unknown} message */
async function handle(message) {
  const type = message && typeof message === "object" ? /** @type {{ type?: unknown }} */ (message).type : undefined;
  if (type === "ping") return { ok: true };
  if (type === "launch") return launch();
  return { ok: false, error: "unknown" };
}

function main() {
  let buf = Buffer.alloc(0);
  let received = false;
  const idle = setTimeout(() => process.exit(0), IDLE_MS);
  const reply = (/** @type {unknown} */ answer) => process.stdout.write(encode(answer), () => process.exit(0));
  process.stdin.on("data", (chunk) => {
    if (received) return;
    buf = Buffer.concat([buf, chunk]);
    const result = decode(buf);
    if (!result.done) return;
    received = true;
    clearTimeout(idle);
    if ("error" in result) reply({ ok: false, error: result.error });
    else void handle(result.message).then(reply);
  });
  process.stdin.on("end", () => {
    if (!received) process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { encode, decode, launchSpec, launchArgsFrom, launchEnv };
