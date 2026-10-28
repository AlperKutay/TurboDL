import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Decoded = { done: false } | { done: true; message: unknown } | { done: true; error: string };
interface HostModule {
  encode(message: unknown): Buffer;
  decode(buf: Buffer): Decoded;
  launchSpec(platform: string, execPath: string, launchArgs: string[], env?: Record<string, string | undefined>): { file: string; args: string[] };
  launchArgsFrom(argv: string[]): string[];
}

const HOST = path.join(__dirname, "..", "..", "resources", "native-host", "host.cjs");
const host = createRequire(import.meta.url)(HOST) as HostModule;

describe("native host framing", () => {
  it("round-trips a length-prefixed JSON message", () => {
    const frame = host.encode({ type: "ping", text: "żółć" });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(host.decode(frame)).toEqual({ done: true, message: { type: "ping", text: "żółć" } });
  });

  it("waits for the rest of a split message and rejects oversized or broken ones", () => {
    const frame = host.encode({ type: "launch" });
    expect(host.decode(frame.subarray(0, 3))).toEqual({ done: false });
    expect(host.decode(frame.subarray(0, frame.length - 1))).toEqual({ done: false });
    const big = Buffer.alloc(4);
    big.writeUInt32LE(2 * 1024 * 1024, 0);
    expect(host.decode(big)).toEqual({ done: true, error: "too large" });
    expect(host.decode(Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{x}")]))).toEqual({ done: true, error: "json" });
  });
});

describe("launchSpec", () => {
  it("starts the Windows executable in the background, after any launch arguments", () => {
    const exe = "C:\\Users\\a\\AppData\\Local\\Programs\\TurboDL\\TurboDL.exe";
    expect(host.launchSpec("win32", exe, [])).toEqual({ file: exe, args: ["--hidden"] });
    expect(host.launchSpec("win32", "C:\\e\\electron.exe", ["C:\\dev\\apps\\desktop"])).toEqual({ file: "C:\\e\\electron.exe", args: ["C:\\dev\\apps\\desktop", "--hidden"] });
  });

  it("hands a macOS app bundle to open, so the app is not a child of the browser", () => {
    expect(host.launchSpec("darwin", "/Applications/Turbo DL.app/Contents/MacOS/TurboDL", [])).toEqual({
      file: "open",
      args: ["-g", "-a", "/Applications/Turbo DL.app", "--args", "--hidden"],
    });
  });

  it("starts the AppImage file, since its mount goes away when this host exits", () => {
    expect(host.launchSpec("linux", "/tmp/.mount_x/turbodl-app", [], { APPIMAGE: "/home/a/T.AppImage", APPDIR: "/tmp/.mount_x" })).toEqual({
      file: "/home/a/T.AppImage",
      args: ["--hidden"],
    });
  });

  it("starts the .deb executable directly", () => {
    expect(host.launchSpec("linux", "/opt/TurboDL/turbodl-app", [], {})).toEqual({ file: "/opt/TurboDL/turbodl-app", args: ["--hidden"] });
  });

  it("reads launch arguments placed before the browser's own arguments", () => {
    expect(host.launchArgsFrom(["exe", "host.cjs", "--launch-arg=C:\\dev app", "chrome-extension://x/", "--parent-window=0"])).toEqual(["C:\\dev app"]);
  });
});

describe("native host process", () => {
  function talk(frame: Buffer): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOST, "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea/"], { stdio: ["pipe", "pipe", "inherit"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", reject);
      child.on("close", () => {
        const r = host.decode(Buffer.concat(chunks));
        resolve(r.done && "message" in r ? r.message : r);
      });
      child.stdin.end(frame);
    });
  }

  it("answers a ping over stdio and exits", async () => {
    expect(await talk(host.encode({ type: "ping" }))).toEqual({ ok: true });
  });

  it("refuses unknown messages", async () => {
    expect(await talk(host.encode({ type: "delete-everything" }))).toEqual({ ok: false, error: "unknown" });
  });
});
