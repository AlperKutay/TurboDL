import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliStatus, installCli, parseUserPath, removeCli, shellLauncher, withEntry, withoutEntry, writeCliLauncher, type CliInstallDeps } from "../src/main/cli-install";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "turbodl-cli-install-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enc = (kind: string, value: string) => `${Buffer.from(`${kind}\n${value}`, "utf16le").toString("base64")}\r\n`;
const KIND: Record<string, string> = { REG_SZ: "String", REG_EXPAND_SZ: "ExpandString" };

describe("writeCliLauncher", () => {
  it("writes the Windows launcher and its two-line config", () => {
    const launcherExe = path.join(dir, "src.exe");
    writeFileSync(launcherExe, "EXE-1");
    const userDataDir = path.join(dir, "data");
    const r = writeCliLauncher({ platform: "win32", userDataDir, execPath: "C:\\Apps\\TurboDL.exe", script: "C:\\Apps\\resources\\cli\\turbodl.cjs", launcherExe });
    expect(r.binDir).toBe(path.join(userDataDir, "bin"));
    expect(r.command).toBe(path.join(r.binDir, "turbodl.exe"));
    expect(readFileSync(r.command, "utf8")).toBe("EXE-1");
    const cfg = readFileSync(path.join(r.binDir, "turbodl.cfg"));
    expect(cfg.toString("utf8")).toBe("C:\\Apps\\TurboDL.exe\r\nC:\\Apps\\resources\\cli\\turbodl.cjs\r\n");
    expect(cfg[0]).not.toBe(0xef);
  });

  it("copies the launcher only when it changed", () => {
    const launcherExe = path.join(dir, "src.exe");
    writeFileSync(launcherExe, "EXE-1");
    const o = { platform: "win32" as const, userDataDir: path.join(dir, "data"), execPath: "a", script: "b", launcherExe };
    const { command } = writeCliLauncher(o);
    const first = statSync(command).mtimeMs;
    const old = new Date(first - 60_000);
    // an unchanged launcher is left alone: mark it old and see that the time stays
    utimesSync(command, old, old);
    writeCliLauncher(o);
    expect(Math.abs(statSync(command).mtimeMs - old.getTime())).toBeLessThan(2000);
    writeFileSync(launcherExe, "EXE-2");
    writeCliLauncher(o);
    expect(readFileSync(command, "utf8")).toBe("EXE-2");
  });

  it("writes the macOS launcher, executable", () => {
    const execPath = "/Applications/Turbo'DL.app/Contents/MacOS/TurboDL";
    const r = writeCliLauncher({ platform: "darwin", userDataDir: path.join(dir, "data"), execPath, script: "/Applications/x/turbodl.cjs", launcherExe: "" });
    expect(r.command).toBe(path.join(r.binDir, "turbodl"));
    const text = readFileSync(r.command, "utf8");
    expect(text).toBe(shellLauncher(execPath, "/Applications/x/turbodl.cjs"));
    expect(text).toBe(`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/Applications/Turbo'\\''DL.app/Contents/MacOS/TurboDL' '/Applications/x/turbodl.cjs' "$@"\n`);
    if (process.platform !== "win32") expect(statSync(r.command).mode & 0o777).toBe(0o755);
  });

  it("reports a launcher that cannot be copied when there is no old one", () => {
    const o = { platform: "win32" as const, userDataDir: path.join(dir, "data"), execPath: "a", script: "b", launcherExe: path.join(dir, "missing.exe") };
    expect(() => writeCliLauncher(o)).toThrow(/ENOENT/);
  });

  it.skipIf(process.platform !== "win32")("keeps working when the old launcher cannot be replaced", () => {
    const launcherExe = path.join(dir, "src.exe");
    writeFileSync(launcherExe, "EXE-1");
    const binDir = path.join(dir, "data", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(path.join(binDir, "turbodl.exe")); // a copy onto a directory fails
    expect(() => writeCliLauncher({ platform: "win32", userDataDir: path.join(dir, "data"), execPath: "a", script: "b", launcherExe })).not.toThrow();
    expect(readFileSync(path.join(binDir, "turbodl.cfg"), "utf8")).toBe("a\r\nb\r\n");
  });
});

describe("withEntry / withoutEntry", () => {
  const bin = "C:\\Users\\x\\AppData\\Roaming\\TurboDL\\bin";
  it("appends to an empty PATH", () => expect(withEntry("", bin)).toBe(bin));
  it("ignores a trailing ;", () => expect(withEntry("C:\\a;C:\\b;", bin)).toBe(`C:\\a;C:\\b;${bin}`));
  it("keeps an entry that is already there, in another case or with a trailing backslash", () => {
    expect(withEntry(`C:\\a;${bin.toUpperCase()}`, bin)).toBe(`C:\\a;${bin.toUpperCase()}`);
    expect(withEntry(`C:\\a;${bin}\\`, bin)).toBe(`C:\\a;${bin}\\`);
  });
  it("keeps %VAR% entries and the order of the others", () => {
    expect(withEntry("%USERPROFILE%\\bin;C:\\z;C:\\a", bin)).toBe(`%USERPROFILE%\\bin;C:\\z;C:\\a;${bin}`);
  });
  it("removes only our entry, in any spelling", () => {
    expect(withoutEntry(`%USERPROFILE%\\bin;${bin};C:\\a;${bin.toLowerCase()}\\`, bin)).toBe("%USERPROFILE%\\bin;C:\\a");
    expect(withoutEntry(bin, bin)).toBe("");
  });
});

describe("parseUserPath", () => {
  it("reads an expandable value with non-ASCII characters and spaces", () => {
    const value = "%USERPROFILE%\\çğıİşö;C:\\Program Files\\x";
    expect(parseUserPath(enc("ExpandString", value))).toEqual({ type: "REG_EXPAND_SZ", value });
  });
  it("reads a plain string", () => expect(parseUserPath(enc("String", "C:\\a;C:\\b"))).toEqual({ type: "REG_SZ", value: "C:\\a;C:\\b" }));
  it("reads an empty value", () => expect(parseUserPath(enc("String", ""))).toEqual({ type: "REG_SZ", value: "" }));
  it('answers "none" when there is no value', () => expect(parseUserPath("none\r\n")).toBe("none"));
  it("answers null for anything else", () => {
    expect(parseUserPath("")).toBeNull();
    expect(parseUserPath("Access denied")).toBeNull();
    expect(parseUserPath(enc("Binary", "x"))).toBeNull();
  });
});

function fake(over: Partial<CliInstallDeps> & { path?: { type: string; value: string } | null } = {}) {
  const calls: string[][] = [];
  const events: string[] = [];
  let current = over.path === undefined ? { type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\bin;C:\\Tools" } : over.path;
  const admin: string[] = [];
  const deps: CliInstallDeps = {
    platform: "win32",
    userDataDir: "C:\\Users\\x\\AppData\\Roaming\\TurboDL",
    supported: true,
    runReg: async (args) => {
      calls.push(args);
      current = { type: args[args.indexOf("/t") + 1], value: args[args.indexOf("/d") + 1] };
      events.push("add");
      return "";
    },
    readUserPath: async () => {
      
      return current ? enc(KIND[current.type], current.value) : "none";
    },
    broadcast: async () => void events.push("broadcast"),
    runAdmin: async (c) => void admin.push(c),
    linkTarget: () => null,
    ...over,
  };
  return { deps, calls, events, admin, value: () => current };
}
const BIN = path.win32.join("C:\\Users\\x\\AppData\\Roaming\\TurboDL", "bin");

describe("Windows PATH", () => {
  it("adds the folder to the user PATH once, keeping its type and unexpanded entries, then tells running programs", async () => {
    const f = fake();
    expect(await installCli(f.deps)).toEqual({ ok: true });
    expect(f.calls[0]).toEqual(["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", `%USERPROFILE%\\bin;C:\\Tools;${BIN}`, "/f"]);
    expect(f.events).toEqual(["add", "broadcast"]);
    await installCli(f.deps);
    expect(f.calls.filter((c) => c[0] === "add")).toHaveLength(1);
  });

  it("keeps REG_SZ as REG_SZ", async () => {
    const f = fake({ path: { type: "REG_SZ", value: "C:\\a" } });
    await installCli(f.deps);
    expect(f.value()?.type).toBe("REG_SZ");
  });

  it("creates the PATH value as REG_EXPAND_SZ when there is none", async () => {
    const f = fake({ path: null });
    expect(await installCli(f.deps)).toEqual({ ok: true });
    expect(f.calls[0]).toEqual(["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", BIN, "/f"]);
  });

  it("removes only its own entry", async () => {
    const f = fake({ path: { type: "REG_EXPAND_SZ", value: `%USERPROFILE%\\bin;${BIN};C:\\Tools` } });
    expect(await removeCli(f.deps)).toEqual({ ok: true });
    expect(f.value()).toEqual({ type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\bin;C:\\Tools" });
    expect(f.events).toEqual(["add", "broadcast"]);
  });

  it("reports installed from the PATH", async () => {
    expect(await cliStatus(fake().deps)).toEqual({ supported: true, installed: false, where: BIN });
    expect(await cliStatus(fake({ path: { type: "REG_SZ", value: `C:\\a;${BIN}\\` } }).deps)).toEqual({ supported: true, installed: true, where: BIN });
    expect(await cliStatus(fake({ path: null }).deps)).toEqual({ supported: true, installed: false, where: BIN });
  });
});

describe("an unreadable PATH", () => {
  const broken = (read: () => Promise<string>) => fake({ readUserPath: read });
  const MSG = { ok: false, error: "Couldn't read your PATH; nothing was changed." };
  for (const [name, read] of [
    ["fails", async () => Promise.reject(new Error("boom"))],
    ["is garbage", async () => "Access denied"],
  ] as const) {
    it(`writes nothing when the read ${name}`, async () => {
      const f = broken(read);
      expect(await installCli(f.deps)).toEqual(MSG);
      expect(await removeCli(f.deps)).toEqual(MSG);
      expect(f.calls).toEqual([]);
      expect(f.events).toEqual([]);
      expect(await cliStatus(f.deps)).toEqual({ supported: true, installed: false, where: BIN });
    });
  }

  it("keeps non-ASCII entries as they were read", async () => {
    const f = fake({ path: { type: "REG_EXPAND_SZ", value: "%USERPROFILE%\\çğıİşö;C:\\plain" } });
    await installCli(f.deps);
    expect(f.value()?.value).toBe(`%USERPROFILE%\\çğıİşö;C:\\plain;${BIN}`);
  });

  it("removing with no entry of ours changes nothing, even with empty segments", async () => {
    const f = fake({ path: { type: "REG_SZ", value: "C:\\a;;C:\\b;" } });
    expect(await removeCli(f.deps)).toEqual({ ok: true });
    expect(f.calls).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it("shows the first stderr line, not the PATH, when reg fails", async () => {
    const f = fake();
    f.deps.runReg = async () => {
      throw Object.assign(new Error("Command failed: reg add ... /d C:\\very;long;PATH"), { stderr: "ERROR: Access is denied.\r\nmore" });
    };
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "ERROR: Access is denied." });
  });
});

describe("macOS link", () => {
  const mac = (target: string | null) => fake({ platform: "darwin", userDataDir: "/Users/x/Library/Application Support/TurboDL", linkTarget: () => target });
  const ours = "/Users/x/Library/Application Support/TurboDL/bin/turbodl";

  it("links /usr/local/bin/turbodl behind the administrator prompt on macOS", async () => {
    const f = mac(null);
    expect(await installCli(f.deps)).toEqual({ ok: true });
    expect(f.admin).toEqual([`mkdir -p /usr/local/bin && ln -sf '${ours}' /usr/local/bin/turbodl`]);
    expect(await cliStatus(mac(null).deps)).toEqual({ supported: true, installed: false, where: "/usr/local/bin/turbodl" });
    expect(await cliStatus(mac(ours).deps)).toEqual({ supported: true, installed: true, where: "/usr/local/bin/turbodl" });
    const g = mac(ours);
    expect(await removeCli(g.deps)).toEqual({ ok: true });
    expect(g.admin).toEqual(["rm -f /usr/local/bin/turbodl"]);
  });

  it("refuses to remove a turbodl that points elsewhere", async () => {
    const f = mac("/opt/homebrew/bin/turbodl");
    expect(await removeCli(f.deps)).toEqual({ ok: false, error: "/usr/local/bin/turbodl belongs to another program." });
    expect(f.admin).toEqual([]);
  });

  it("answers a cancelled prompt", async () => {
    const f = mac(null);
    f.deps.runAdmin = async () => {
      throw Object.assign(new Error("User canceled. (-128)"), { cancelled: true });
    };
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "Cancelled." });
  });
});

describe("outside the installed app", () => {
  it('answers "Available in the installed app."', async () => {
    const f = fake({ supported: false });
    expect(await cliStatus(f.deps)).toEqual({ supported: false, installed: false, where: "" });
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "Available in the installed app." });
    expect(await removeCli(f.deps)).toEqual({ ok: false, error: "Available in the installed app." });
    expect(f.calls).toEqual([]);
  });
});
