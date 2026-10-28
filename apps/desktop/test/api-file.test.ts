import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiLaunch } from "@turbodl/shared";
import { clientLaunch, writeApiFile } from "../src/main/api-file";

const launch: ApiLaunch = { file: "app", args: ["--hidden"] };
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-api-"));
  file = path.join(dir, "api.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (port: number | null, error?: string) => writeApiFile({ userDataDir: dir, version: "0.0.1", port, launch, error });

/** An error as fs throws it, with its code. */
const fsError = (code: string) => Object.assign(new Error(`${code}: the file is in use`), { code });

describe("writeApiFile", () => {
  it("writes the API version, app version, port, launch and a 64-hex token", async () => {
    const written = await write(47999);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual({ api: 1, version: "0.0.1", port: 47999, token: expect.stringMatching(/^[0-9a-f]{64}$/), launch });
    expect(written).toEqual(parsed);
  });

  it("keeps the token on later writes and takes the new port", async () => {
    const first = await write(47999);
    const second = await write(48000);
    expect(second.token).toBe(first.token);
    expect(JSON.parse(readFileSync(file, "utf8")).port).toBe(48000);
  });

  it("replaces a token that isn't 64 hex characters, and a file that isn't JSON", async () => {
    writeFileSync(file, JSON.stringify({ token: "abc" }));
    expect((await write(1)).token).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(file, "not json");
    expect((await write(1)).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes port null when the bridge couldn't listen", async () => {
    expect((await write(null)).port).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).port).toBeNull();
  });

  it("writes the app's own message with port null, and none while the port is open", async () => {
    const taken = "Port 47123 is used by another program. Choose another port in Settings.";
    expect(await write(null, taken)).toMatchObject({ port: null, error: taken });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ port: null, error: taken });
    expect(await write(47123, taken)).not.toHaveProperty("error");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("error");
  });

  it.skipIf(process.platform === "win32")("is readable by the user only", async () => {
    chmodSync(dir, 0o700);
    await write(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tries the rename again, 50 ms apart, while a client holds api.json", async () => {
    const waits: number[] = [];
    const codes = ["EPERM", "EBUSY"];
    let tries = 0;
    const written = await writeApiFile({
      userDataDir: dir,
      version: "0.0.1",
      port: 1,
      launch,
      rename: (from, to) => {
        const code = codes[tries++];
        if (code) throw fsError(code);
        renameSync(from, to);
      },
      wait: async (ms) => void waits.push(ms),
    });
    expect(tries).toBe(3);
    expect(waits).toEqual([50, 50]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(written);
    expect(readdirSync(dir)).toEqual(["api.json"]);
  });

  it("gives up after three more tries, or at once on another error, leaving no temporary file", async () => {
    const waits: number[] = [];
    let tries = 0;
    const failing = (code: string) =>
      writeApiFile({
        userDataDir: dir,
        version: "0.0.1",
        port: 1,
        launch,
        rename: () => {
          tries++;
          throw fsError(code);
        },
        wait: async (ms) => void waits.push(ms),
      });
    await expect(failing("EBUSY")).rejects.toMatchObject({ code: "EBUSY" });
    expect(tries).toBe(4);
    expect(waits).toEqual([50, 50, 50]);
    expect(readdirSync(dir)).toEqual([]);
    tries = 0;
    await expect(failing("EXDEV")).rejects.toMatchObject({ code: "EXDEV" });
    expect(tries).toBe(1);
    expect(waits).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("clientLaunch", () => {
  it("starts a packaged Windows app by its executable", () => {
    const execPath = String.raw`C:\Apps\TurboDL.exe`;
    expect(clientLaunch({ platform: "win32", execPath, isPackaged: true, appPath: "x" })).toEqual({ file: execPath, args: ["--hidden"] });
  });

  it("opens a packaged macOS app by its bundle", () => {
    const execPath = "/Applications/TurboDL.app/Contents/MacOS/TurboDL";
    expect(clientLaunch({ platform: "darwin", execPath, isPackaged: true, appPath: "x" })).toEqual({
      file: "open",
      args: ["-g", "-a", "/Applications/TurboDL.app", "--args", "--hidden"]
    });
  });

  it("starts a packaged AppImage by its file", () => {
    expect(
      clientLaunch({
        platform: "linux",
        execPath: "/tmp/.mount_TurboDabc/turbodl-app",
        isPackaged: true,
        appPath: "x",
        env: { APPIMAGE: "/home/a/Apps/TurboDL.AppImage", APPDIR: "/tmp/.mount_TurboDabc" }
      })
    ).toEqual({ file: "/home/a/Apps/TurboDL.AppImage", args: ["--hidden"] });
  });

  it("starts the .deb by its executable", () => {
    expect(clientLaunch({ platform: "linux", execPath: "/opt/TurboDL/turbodl-app", isPackaged: true, appPath: "x", env: {} })).toEqual({
      file: "/opt/TurboDL/turbodl-app",
      args: ["--hidden"]
    });
  });

  it("passes the app path when running unpackaged", () => {
    const appPath = String.raw`D:\app`;
    expect(clientLaunch({ platform: "win32", execPath: "electron.exe", isPackaged: false, appPath })).toEqual({
      file: "electron.exe",
      args: [appPath, "--hidden"]
    });
  });
});
