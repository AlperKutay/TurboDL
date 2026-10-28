import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliStatus, installCli, parseUserPath, removeCli, run, shellLauncher, withEntry, withoutEntry, writeCliLauncher, type CliInstallDeps } from "../src/main/cli-install";

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
    expect(text).toBe(`#!/bin/sh\n[ -x '/Applications/Turbo'\\''DL.app/Contents/MacOS/TurboDL' ] || { echo "TurboDL is not installed any more." >&2; exit 5; }\nELECTRON_RUN_AS_NODE=1 exec '/Applications/Turbo'\\''DL.app/Contents/MacOS/TurboDL' '/Applications/x/turbodl.cjs' "$@"\n`);
    if (process.platform !== "win32") expect(statSync(r.command).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")("exits 5 with a message when TurboDL is gone", () => {
    const r = writeCliLauncher({ platform: "darwin", userDataDir: path.join(dir, "data"), execPath: path.join(dir, "gone", "TurboDL"), script: path.join(dir, "x.cjs"), launcherExe: "" });
    const res = spawnSync("/bin/sh", [r.command, "--version"], { encoding: "utf8" });
    expect(res.status).toBe(5);
    expect(res.stderr).toBe("TurboDL is not installed any more.\n");
  });

  it("writes the Linux launcher for the .deb like the macOS one", () => {
    const r = writeCliLauncher({ platform: "linux", userDataDir: path.join(dir, "data"), execPath: "/opt/TurboDL/turbodl-app", script: "/opt/TurboDL/resources/cli/turbodl.cjs", launcherExe: "" });
    expect(readFileSync(r.command, "utf8")).toBe(shellLauncher("/opt/TurboDL/turbodl-app", "/opt/TurboDL/resources/cli/turbodl.cjs"));
    if (process.platform !== "win32") expect(statSync(r.command).mode & 0o777).toBe(0o755);
  });

  it("copies the command next to an AppImage launcher and passes the AppRun flag after it", () => {
    const script = path.join(dir, "turbodl.cjs");
    writeFileSync(script, "// cli");
    const r = writeCliLauncher({
      platform: "linux",
      userDataDir: path.join(dir, "data"),
      execPath: "/tmp/.mount_x/turbodl-app",
      script,
      launcherExe: "",
      env: { APPIMAGE: "/home/a/O'Neil/TurboDL.AppImage", APPDIR: "/tmp/.mount_x" },
    });
    const copy = path.join(r.binDir, "turbodl.cjs");
    expect(readFileSync(copy, "utf8")).toBe("// cli");
    expect(readFileSync(r.command, "utf8")).toBe(
      `#!/bin/sh\n[ -x '/home/a/O'\\''Neil/TurboDL.AppImage' ] || { echo "TurboDL is not installed any more." >&2; exit 5; }\nELECTRON_RUN_AS_NODE=1 exec '/home/a/O'\\''Neil/TurboDL.AppImage' '${copy}' --no-sandbox "$@"\n`,
    );
  });

  it.skipIf(process.platform === "win32")("hands the AppImage the script, the flag, then the user's arguments", () => {
    const echo = path.join(dir, "echo.cjs");
    writeFileSync(echo, "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));\n");
    const appImage = path.join(dir, "TurboDL.AppImage");
    // a stand-in AppImage: runs the script it is given, like Electron in Node mode
    writeFileSync(appImage, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(appImage, 0o755);
    const r = writeCliLauncher({
      platform: "linux",
      userDataDir: path.join(dir, "data"),
      execPath: "/tmp/.mount_x/turbodl-app",
      script: echo,
      launcherExe: "",
      env: { APPIMAGE: appImage, APPDIR: "/tmp/.mount_x" },
    });
    const copy = path.join(r.binDir, "turbodl.cjs");
    const res = spawnSync("/bin/sh", [r.command, "get", "a b"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    // process.argv.slice(2) of the copy: the flag, then the user's arguments
    expect(JSON.parse(res.stdout)).toEqual({ argv: ["--no-sandbox", "get", "a b"], node: "1" });
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(echo, "utf8"));
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
  const links: string[][] = [];
  const unlinks: string[] = [];
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
    exists: () => false,
    homeDir: "/home/a",
    pathEnv: "",
    symlink: (target, file) => void links.push([target, file]),
    unlink: (file) => void unlinks.push(file),
    ...over,
  };
  return { deps, calls, events, admin, links, unlinks, value: () => current };
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

  it("answers ok when only the broadcast fails: the PATH did change", async () => {
    const f = fake({ broadcast: async () => Promise.reject(new Error("no powershell")) });
    expect(await installCli(f.deps)).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
  });

  it("shows the first stderr line of a command that really fails, not the PATH", async () => {
    const f = fake();
    // the real run(), with a harmless failing command in place of reg
    f.deps.runReg = () => run(process.execPath, ["-e", "process.stderr.write('ERROR: Access is denied.\\r\\nmore'); process.exit(1)"]);
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "ERROR: Access is denied." });
  });

  it("answers a command that takes too long", async () => {
    const f = fake();
    f.deps.runReg = () => run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 200);
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "Timed out." });
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

  it("refuses to install over a turbodl that is not ours", async () => {
    const other = mac("/opt/homebrew/bin/turbodl");
    expect(await installCli(other.deps)).toEqual({ ok: false, error: "/usr/local/bin/turbodl belongs to another program." });
    const file = fake({ platform: "darwin", userDataDir: "/Users/x/Library/Application Support/TurboDL", linkTarget: () => null, exists: () => true });
    expect(await installCli(file.deps)).toEqual({ ok: false, error: "/usr/local/bin/turbodl belongs to another program." });
    expect(other.admin).toEqual([]);
    expect(file.admin).toEqual([]);
    const again = mac(ours); // our own link is simply relinked
    expect(await installCli(again.deps)).toEqual({ ok: true });
    expect(again.admin).toHaveLength(1);
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

describe("Linux link", () => {
  const userDataDir = "/home/a/.config/TurboDL";
  const ours = "/home/a/.config/TurboDL/bin/turbodl";
  const L = "/home/a/.local/bin/turbodl";
  const linux = (over: Partial<CliInstallDeps> = {}) => fake({ platform: "linux", userDataDir, ...over });

  it("links ~/.local/bin/turbodl to the launcher without a password", async () => {
    const f = linux();
    expect(await installCli(f.deps)).toEqual({ ok: true });
    expect(f.links).toEqual([[ours, L]]);
    expect(f.admin).toEqual([]);
  });

  it("reports installed, and whether ~/.local/bin is on the PATH", async () => {
    expect(await cliStatus(linux({ linkTarget: () => ours, pathEnv: "/usr/bin:/bin" }).deps)).toEqual({ supported: true, installed: true, where: L, onPath: false });
    expect(await cliStatus(linux({ linkTarget: () => ours, pathEnv: "/home/a/.local/bin/:/usr/bin" }).deps)).toMatchObject({ installed: true, onPath: true });
    expect(await cliStatus(linux().deps)).toMatchObject({ installed: false, where: L });
  });

  it("refuses to install over or remove a turbodl that is not ours", async () => {
    const error = "~/.local/bin/turbodl belongs to another program.";
    const other = linux({ linkTarget: () => "/usr/local/bin/other" });
    const file = linux({ linkTarget: () => null, exists: () => true });
    expect(await installCli(other.deps)).toEqual({ ok: false, error });
    expect(await installCli(file.deps)).toEqual({ ok: false, error });
    expect(await removeCli(other.deps)).toEqual({ ok: false, error });
    expect(other.links).toEqual([]);
    expect(file.links).toEqual([]);
    expect(other.unlinks).toEqual([]);
  });

  it("removes only its own link", async () => {
    const mine = linux({ linkTarget: () => ours });
    expect(await removeCli(mine.deps)).toEqual({ ok: true });
    expect(mine.unlinks).toEqual([L]);
    const none = linux();
    expect(await removeCli(none.deps)).toEqual({ ok: true });
    expect(none.unlinks).toEqual([]);
  });

  it("answers a link it can't make", async () => {
    const f = linux({
      symlink: () => {
        throw new Error("EACCES: permission denied, symlink 'x' -> 'y'");
      },
    });
    expect(await installCli(f.deps)).toEqual({ ok: false, error: "EACCES: permission denied, symlink 'x' -> 'y'" });
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
