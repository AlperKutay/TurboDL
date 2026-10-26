import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const write = (port: number | null) => writeApiFile({ userDataDir: dir, version: "0.0.1", port, launch });

describe("writeApiFile", () => {
  it("writes the API version, app version, port, launch and a 64-hex token", () => {
    const written = write(47999);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual({ api: 1, version: "0.0.1", port: 47999, token: expect.stringMatching(/^[0-9a-f]{64}$/), launch });
    expect(written).toEqual(parsed);
  });

  it("keeps the token on later writes and takes the new port", () => {
    const first = write(47999);
    const second = write(48000);
    expect(second.token).toBe(first.token);
    expect(JSON.parse(readFileSync(file, "utf8")).port).toBe(48000);
  });

  it("replaces a token that isn't 64 hex characters, and a file that isn't JSON", () => {
    writeFileSync(file, JSON.stringify({ token: "abc" }));
    expect(write(1).token).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(file, "not json");
    expect(write(1).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes port null when the bridge couldn't listen", () => {
    expect(write(null).port).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).port).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("is readable by the user only on macOS", () => {
    chmodSync(dir, 0o700);
    write(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("clientLaunch", () => {
  it("starts a packaged Windows app by its executable", () => {
    const execPath = "C:\Apps\TurboDL.exe";
    expect(clientLaunch({ platform: "win32", execPath, isPackaged: true, appPath: "x" })).toEqual({ file: execPath, args: ["--hidden"] });
  });

  it("opens a packaged macOS app by its bundle", () => {
    const execPath = "/Applications/TurboDL.app/Contents/MacOS/TurboDL";
    expect(clientLaunch({ platform: "darwin", execPath, isPackaged: true, appPath: "x" })).toEqual({
      file: "open",
      args: ["-g", "-a", "/Applications/TurboDL.app", "--args", "--hidden"]
    });
  });

  it("passes the app path when running unpackaged", () => {
    expect(clientLaunch({ platform: "win32", execPath: "electron.exe", isPackaged: false, appPath: "D:\app" })).toEqual({
      file: "electron.exe",
      args: ["D:\app", "--hidden"]
    });
  });
});
