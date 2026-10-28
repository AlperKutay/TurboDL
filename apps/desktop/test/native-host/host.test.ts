import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPRUN_ENV, DUMP_ENV, dumpedEnv } from "../fixtures/env-dump";

type Env = Record<string, string | undefined>;
type Decoded = { done: false } | { done: true; message: unknown } | { done: true; error: string };
interface HostModule {
  encode(message: unknown): Buffer;
  decode(buf: Buffer): Decoded;
  launchSpec(platform: string, execPath: string, launchArgs: string[], env?: Env): { file: string; args: string[] };
  launchArgsFrom(argv: string[]): string[];
  launchEnv(env: Env): Env;
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

// the same cases as launchEnv in app-location.test.ts
describe("launchEnv", () => {
  const appRun = {
    APPDIR: "/tmp/.mount_x",
    APPIMAGE: "/home/a/T.AppImage",
    ARGV0: "./T.AppImage",
    OWD: "/home/a",
    PATH: "/tmp/.mount_x:/tmp/.mount_x/usr/sbin:/usr/bin",
    LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib:/tmp/.mount_x/usr/lib/x86_64-linux-gnu",
    XDG_DATA_DIRS: "/tmp/.mount_x/usr/share/:/usr/share",
    GSETTINGS_SCHEMA_DIR: "/tmp/.mount_x/usr/share/glib-2.0/schemas:/usr/share/glib-2.0/schemas",
    ELECTRON_RUN_AS_NODE: "1",
    HOME: "/home/a",
  };

  it("leaves out an AppImage mount, which goes away when this host exits", () => {
    expect(host.launchEnv(appRun)).toEqual({ PATH: "/usr/bin", XDG_DATA_DIRS: "/usr/share", GSETTINGS_SCHEMA_DIR: "/usr/share/glib-2.0/schemas", HOME: "/home/a" });
  });

  it("does not change the environment it is given", () => {
    const env = { ...appRun };
    host.launchEnv(env);
    expect(env).toEqual(appRun);
  });

  it("keeps a folder that only shares the mount's prefix", () => {
    expect(host.launchEnv({ APPDIR: "/tmp/.mount_x", PATH: "/tmp/.mount_xy/bin:/tmp/.mount_x/usr/bin:/usr/bin" }).PATH).toBe("/tmp/.mount_xy/bin:/usr/bin");
  });

  it("only drops ELECTRON_RUN_AS_NODE without an AppImage (the .deb, Windows and macOS)", () => {
    const env = { PATH: "/tmp/.mount_x/usr/bin:/usr/bin", LD_LIBRARY_PATH: "/opt/lib", APPIMAGE: "/home/a/T.AppImage", OWD: "/home/a", HOME: "/home/a" };
    expect(host.launchEnv({ ...env, ELECTRON_RUN_AS_NODE: "1" })).toEqual(env);
    expect(host.launchEnv({ ...env, APPDIR: "" })).toEqual({ ...env, APPDIR: "" });
  });
});

describe("native host process", () => {
  function talk(frame: Buffer, args: string[] = [], env: Env = process.env): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOST, ...args, "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea/"], { stdio: ["pipe", "pipe", "inherit"], env });
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

  it("starts TurboDL without Node mode or the host's AppImage mount", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-host-launch-"));
    try {
      const out = path.join(dir, "env.json");
      const answer = await talk(host.encode({ type: "launch" }), [`--launch-arg=${DUMP_ENV}`], { ...process.env, ...APPRUN_ENV, TURBODL_ENV_OUT: out });
      expect(answer).toEqual({ ok: true });
      const env = await dumpedEnv(out);
      expect(env.TURBODL_ENV_OUT).toBe(out);
      expect(env.XDG_DATA_DIRS).toBe("/usr/share");
      for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE"]) expect(env[name], name).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
