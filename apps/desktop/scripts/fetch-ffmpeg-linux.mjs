// Linux only: puts BtbN's FFmpeg build (https://github.com/BtbN/FFmpeg-Builds) in build/ffmpeg-linux/ffmpeg.
// ffmpeg-static's Linux binary links an old glibc statically, and that glibc still loads the system's gconv and NSS
// modules at run time: it crashes on every MPEG-TS (HLS) input with glibc 2.39 or newer, and on any http://<hostname>.
// BtbN's build links glibc dynamically (the system's) and everything else statically.
// The archive's SHA-256 must match the release's checksums.sha256. Does nothing when the binary is already there and runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RELEASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
const ASSET = "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "ffmpeg-linux");
const target = path.join(outDir, "ffmpeg");

const runs = (file) => existsSync(file) && spawnSync(file, ["-version"], { timeout: 20000 }).status === 0;
const firstLine = (file) => (spawnSync(file, ["-version"], { encoding: "utf8", timeout: 20000 }).stdout ?? "").split("\n")[0];

async function get(name) {
  const res = await fetch(RELEASE + name);
  if (!res.ok || !res.body) throw new Error(`${RELEASE + name}: HTTP ${res.status}`);
  return res;
}

/** Downloads the archive into `dir`; returns its path and SHA-256, and the hash the release lists for it. */
async function download(dir) {
  const archive = path.join(dir, ASSET);
  const hash = createHash("sha256");
  const tee = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb((await get(ASSET)).body), tee, createWriteStream(archive));
  const sums = await (await get("checksums.sha256")).text();
  const listed = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p.length === 2 && p[1] === ASSET)?.[0];
  return { archive, actual: hash.digest("hex"), listed };
}

async function main() {
  if (process.platform !== "linux") return;
  if (runs(target)) {
    console.log(`ffmpeg-linux: ${firstLine(target)} (already there)`);
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "turbodl-ffmpeg-"));
  try {
    console.log(`ffmpeg-linux: downloading ${ASSET}`);
    let got = await download(tmp);
    // the release's files are replaced one by one when BtbN publishes a build: a mismatch can be that window
    if (got.listed && got.actual !== got.listed) {
      console.log("ffmpeg-linux: checksum mismatch, retrying once in 90 s (the release may be updating)");
      await new Promise((r) => setTimeout(r, 90000));
      got = await download(tmp);
    }
    if (!got.listed) throw new Error(`checksums.sha256 does not list ${ASSET}`);
    if (got.actual !== got.listed) throw new Error(`SHA-256 mismatch for ${ASSET}: got ${got.actual}, the release lists ${got.listed}`);

    const res = spawnSync("tar", ["-xJf", got.archive, "-C", tmp, "--strip-components=2", "--wildcards", "*/bin/ffmpeg"], { encoding: "utf8" });
    const extracted = path.join(tmp, "ffmpeg");
    if (res.status !== 0 || !existsSync(extracted)) throw new Error(`tar could not extract bin/ffmpeg: ${res.stderr || res.error}`);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(extracted, `${target}.part`);
    chmodSync(`${target}.part`, 0o755);
    renameSync(`${target}.part`, target);
    if (!runs(target)) throw new Error(`${target} does not run`);
    console.log(`ffmpeg-linux: ${firstLine(target)} (sha256 ${got.actual})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`ffmpeg-linux: ${e.message}`);
  process.exit(1);
});
