import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiFile, ApiLaunch } from "@turbodl/shared";
import { connect, readApiFile, spawnDetached, userDataDir, type Connection } from "../../src/cli/discover";
import { APPRUN_ENV, DUMP_ENV, dumpedEnv } from "../fixtures/env-dump";

describe("userDataDir", () => {
  it("prefers TURBODL_USER_DATA", () => {
    expect(userDataDir({ TURBODL_USER_DATA: "/x/y" }, "win32", "/h")).toBe("/x/y");
  });
  it("uses APPDATA on Windows, else the roaming folder under home", () => {
    expect(userDataDir({ APPDATA: "C:\\A" }, "win32", "C:\\H")).toBe(path.join("C:\\A", "TurboDL"));
    expect(userDataDir({}, "win32", "C:\\H")).toBe(path.join("C:\\H", "AppData", "Roaming", "TurboDL"));
  });
  it("follows XDG_CONFIG_HOME on Linux, as the app does", () => {
    expect(userDataDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/a")).toBe(path.join("/x/cfg", "TurboDL"));
    expect(userDataDir({ XDG_CONFIG_HOME: "" }, "linux", "/home/a")).toBe(path.join("/home/a", ".config", "TurboDL"));
    expect(userDataDir({ XDG_CONFIG_HOME: "/x/cfg" }, "darwin", "/Users/a")).toBe(path.join("/Users/a", "Library", "Application Support", "TurboDL"));
  });
  it("uses Application Support on macOS and ~/.config on Linux", () => {
    expect(userDataDir({}, "darwin", "/Users/a")).toBe(path.join("/Users/a", "Library", "Application Support", "TurboDL"));
    expect(userDataDir({}, "linux", "/home/a")).toBe(path.join("/home/a", ".config", "TurboDL"));
  });
});

const launch: ApiLaunch = { file: "turbodl", args: ["--hidden"] };
let dir: string;

function write(file: Partial<ApiFile>) {
  const full: ApiFile = { api: 1, version: "1", port: 5000, token: "tok", launch, ...file };
  fs.writeFileSync(path.join(dir, "api.json"), JSON.stringify(full));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "turbodl-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readApiFile", () => {
  it("returns null for a missing or broken file", () => {
    expect(readApiFile(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "api.json"), "{nope");
    expect(readApiFile(dir)).toBeNull();
  });
  it("returns a valid file", () => {
    write({ port: 4242 });
    expect(readApiFile(dir)?.port).toBe(4242);
  });
});

describe("connect", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("answers at once when the app is running", async () => {
    write({});
    let spawned = 0;
    const r = await connect({ dir, spawn: () => void spawned++, ping: async () => true, ...clock() });
    expect(r).toEqual({ port: 5000, token: "tok" });
    expect(spawned).toBe(0);
  });

  it("starts the app once and waits until it answers", async () => {
    write({});
    let spawned = 0;
    let pings = 0;
    const r = await connect({
      dir,
      spawn: (l) => {
        expect(l).toEqual(launch);
        spawned++;
      },
      ping: async () => ++pings >= 3,
      ...clock(),
    });
    expect(r).toEqual({ port: 5000, token: "tok" });
    expect(spawned).toBe(1);
    expect(pings).toBe(3);
  });

  it("follows a port that changes after the start", async () => {
    write({});
    const seen: Connection[] = [];
    const r = await connect({
      dir,
      spawn: () => write({ port: 6000, token: "new" }),
      ping: async (c) => (seen.push(c), c.port === 6000),
      ...clock(),
    });
    expect(r).toEqual({ port: 6000, token: "new" });
  });

  it("gives up after 30 seconds", async () => {
    write({});
    const c = clock();
    const r = await connect({ dir, spawn: () => undefined, ping: async () => false, ...c });
    expect(r).toEqual({ error: "TurboDL didn't start within 30 seconds." });
    expect(c.now()).toBeGreaterThanOrEqual(30000);
  });

  it("uses the app's own message while the port stays null", async () => {
    write({ port: null, error: "Port 47123 is used by another program. Choose another port in Settings." });
    const r = await connect({ dir, spawn: () => undefined, ping: async () => true, ...clock() });
    expect(r).toEqual({ error: "Port 47123 is used by another program. Choose another port in Settings." });
  });

  it("answers a taken port after the 5 s grace, not the full wait", async () => {
    write({ port: null, error: "taken" });
    const c = clock();
    let spawned = 0;
    const r = await connect({ dir, spawn: () => void spawned++, ping: async () => true, ...c });
    expect(r).toEqual({ error: "taken" });
    expect(spawned).toBe(1);
    expect(c.now()).toBeGreaterThanOrEqual(5000);
    expect(c.now()).toBeLessThan(6000);
  });

  it("connects when the port appears within the grace", async () => {
    write({ port: null });
    const c = clock();
    const r = await connect({
      dir,
      spawn: () => undefined,
      ping: async () => true,
      now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms);
        if (c.now() >= 3000) write({ port: 7000 });
      },
    });
    expect(r).toEqual({ port: 7000, token: "tok" });
  });

  it("falls back to the fixed port message without an app message", async () => {
    write({ port: null });
    const r = await connect({ dir, spawn: () => undefined, ping: async () => true, ...clock() });
    expect(r).toEqual({ error: "TurboDL couldn't open its local port. Pick another port in TurboDL's Settings." });
  });

  it("tells a first-time user to open the app", async () => {
    const r = await connect({ dir, spawn: () => undefined, ping: async () => true, ...clock() });
    expect(r).toEqual({ error: "TurboDL hasn't been opened on this computer yet. Open it once, then try again." });
  });
});

describe("spawnDetached", () => {
  it("starts the app without Node mode or this command's AppImage mount", async () => {
    const out = path.join(dir, "env.json");
    spawnDetached({ file: process.execPath, args: [DUMP_ENV, "--hidden"] }, { ...process.env, ...APPRUN_ENV, TURBODL_ENV_OUT: out });
    const env = await dumpedEnv(out);
    expect(env.TURBODL_ENV_OUT).toBe(out);
    expect(env.XDG_DATA_DIRS).toBe("/usr/share");
    for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE"]) expect(env[name], name).toBeUndefined();
  });
});
