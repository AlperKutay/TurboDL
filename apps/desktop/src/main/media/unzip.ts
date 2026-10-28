import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

class Damaged extends Error {
  constructor() {
    super("The archive is damaged.");
  }
}

function safeName(name: string): void {
  const bad =
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((part) => part === "..");
  if (bad) throw new Error(`Unsafe path in the archive: ${name}`);
}

async function readAt(fh: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead < length) throw new Error("Could not open the archive.");
  return buf;
}

async function readEntries(fh: fsp.FileHandle, fileSize: number): Promise<Entry[]> {
  const tailLen = Math.min(fileSize, 22 + 65535);
  const tailStart = fileSize - tailLen;
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, tailStart);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Could not open the archive.");
  const count = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error("ZIP64 archives aren't supported.");
  if (dirOffset + dirSize > fileSize) throw new Error("Could not open the archive.");

  const dir = await readAt(fh, dirOffset, dirSize);
  const entries: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("Could not open the archive.");
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    if (p + 46 + nameLen > dir.length) throw new Error("Could not open the archive.");
    entries.push({
      name: dir.toString("utf8", p + 46, p + 46 + nameLen),
      method: dir.readUInt16LE(p + 10),
      crc: dir.readUInt32LE(p + 16),
      compressed: dir.readUInt32LE(p + 20),
      size: dir.readUInt32LE(p + 24),
      offset: dir.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractFile(fh: fsp.FileHandle, zip: string, fileSize: number, e: Entry, target: string): Promise<void> {
  const local = await readAt(fh, e.offset, 30).catch(() => {
    throw new Damaged();
  });
  if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Damaged();
  const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + e.compressed > fileSize) throw new Damaged();

  await fsp.mkdir(path.dirname(target), { recursive: true });
  let written = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > e.size) return cb(new Damaged());
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const source = e.compressed === 0 ? Readable.from([]) : createReadStream(zip, { start, end: start + e.compressed - 1 });
  try {
    const stages = e.method === 8 ? [source, zlib.createInflateRaw(), check, createWriteStream(target)] : [source, check, createWriteStream(target)];
    await pipeline(stages as [Readable, ...Transform[], NodeJS.WritableStream]);
    if (written !== e.size || crc >>> 0 !== e.crc) throw new Damaged();
  } catch (err) {
    await fsp.rm(target, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof Damaged || (typeof code === "string" && code.startsWith("Z_"))) throw new Damaged();
    throw err;
  }
}

/** Extracts every entry of a zip (stored or deflated, no ZIP64) into dest; the partly written file is removed on any error. */
export async function unzip(zip: string, dest: string): Promise<void> {
  const fh = await fsp.open(zip, "r");
  try {
    const { size } = await fh.stat();
    const entries = await readEntries(fh, size);
    const root = path.resolve(dest);
    const plan = entries.map((e) => {
      safeName(e.name);
      const isDir = e.name.endsWith("/");
      if (!isDir && e.method !== 0 && e.method !== 8) throw new Error(`Unsupported compression method ${e.method} in the archive.`);
      const target = path.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path in the archive: ${e.name}`);
      return { e, isDir, target };
    });
    for (const { e, isDir, target } of plan) {
      if (isDir) await fsp.mkdir(target, { recursive: true });
      else await extractFile(fh, zip, size, e, target);
    }
  } finally {
    await fh.close();
  }
}
