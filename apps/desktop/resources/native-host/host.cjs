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
 */
function launchSpec(platform, execPath, launchArgs) {
  const bundle = platform === "darwin" ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath) : null;
  // `open` hands the app to launchd, so it outlives the browser and this host
  if (bundle) return { file: "open", args: ["-g", "-a", bundle[1], "--args", "--hidden"] };
  return { file: execPath, args: [...launchArgs, "--hidden"] };
}

/** @param {string[]} argv */
function launchArgsFrom(argv) {
  return argv.filter((a) => a.startsWith("--launch-arg=")).map((a) => a.slice("--launch-arg=".length));
}

function launch() {
  const spec = launchSpec(process.platform, process.execPath, launchArgsFrom(process.argv));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
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

module.exports = { encode, decode, launchSpec, launchArgsFrom };
