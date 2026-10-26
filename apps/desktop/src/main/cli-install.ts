import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CliStatus, Result } from "@turbodl/shared";

const LINK = "/usr/local/bin/turbodl";
const ENV_KEY = "HKCU\\Environment";
const UNAVAILABLE: Result = { ok: false, error: "Available in the installed app." };

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The macOS `turbodl` script: runs the command in Node mode of this TurboDL. */
export function shellLauncher(execPath: string, script: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(execPath)} ${shQuote(script)} "$@"\n`;
}

/** <userData>/bin with turbodl.exe + turbodl.cfg (Windows) or the turbodl script (macOS), pointing at this TurboDL. */
export function writeCliLauncher(o: { platform: NodeJS.Platform; userDataDir: string; execPath: string; script: string; launcherExe: string }): { binDir: string; command: string } {
  const p = path; // real files: the host's own separators
  const binDir = p.join(o.userDataDir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (o.platform === "win32") {
    const command = p.join(binDir, "turbodl.exe");
    let current: Buffer | null = null;
    try {
      current = readFileSync(command);
    } catch {
      // not there yet
    }
    if (!current || !current.equals(readFileSync(o.launcherExe))) {
      try {
        copyFileSync(o.launcherExe, command);
      } catch (err) {
        // a running command keeps its file locked; the old launcher reads the same config
        const code = (err as NodeJS.ErrnoException).code;
        if (!((code === "EBUSY" || code === "EPERM") && existsSync(command))) throw err;
      }
    }
    writeFileSync(p.join(binDir, "turbodl.cfg"), `${o.execPath}\r\n${o.script}\r\n`, "utf8");
    return { binDir, command };
  }
  const command = p.join(binDir, "turbodl");
  writeFileSync(command, shellLauncher(o.execPath, o.script));
  chmodSync(command, 0o755);
  return { binDir, command };
}

/** Everything the PATH install touches outside this process, so tests can fake it. */
export interface CliInstallDeps {
  platform: NodeJS.Platform;
  userDataDir: string;
  /** app.isPackaged */
  supported: boolean;
  /** reg.exe, to write the PATH value */
  runReg(args: string[]): Promise<string>;
  /** the user PATH as PowerShell reports it (see USER_PATH_SCRIPT), safe for any characters */
  readUserPath(): Promise<string>;
  /** tells running programs the environment changed */
  broadcast(): Promise<void>;
  /** macOS: a shell command behind the administrator prompt */
  runAdmin(command: string): Promise<void>;
  /** readlink; null when not a link */
  linkTarget(file: string): string | null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Prints the user PATH unexpanded, with its kind, as base64 of UTF-16LE "<Kind>
<value>"; "none" when there is no value. */
const USER_PATH_SCRIPT =
  "$k = Get-Item -LiteralPath 'HKCU:\\Environment'; if ($k.GetValueNames() -contains 'Path') { $v = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); $t = $k.GetValueKind('Path'); [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($t.ToString() + [char]10 + $v)) } else { 'none' }";

const BROADCAST_SCRIPT = "[Environment]::SetEnvironmentVariable('TURBODL_PATH_REFRESH','1','User'); [Environment]::SetEnvironmentVariable('TURBODL_PATH_REFRESH',$null,'User')";

/** The real reg.exe, PowerShell, osascript and readlink. */
export function realCliDeps(o: { platform: NodeJS.Platform; userDataDir: string; supported: boolean }): CliInstallDeps {
  return {
    ...o,
    runReg: (args) => run("reg", args),
    readUserPath: () => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", USER_PATH_SCRIPT]),
    // writing and clearing a user variable makes Windows send WM_SETTINGCHANGE to running programs
    broadcast: async () => void (await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", BROADCAST_SCRIPT])),
    runAdmin: async (command) => {
      const quoted = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await run("osascript", ["-e", `do shell script "${quoted}" with administrator privileges`]);
    },
    linkTarget: (file) => {
      try {
        return readlinkSync(file);
      } catch {
        return null;
      }
    },
  };
}

function binDirOf(d: CliInstallDeps): string {
  return pathFor(d.platform).join(d.userDataDir, "bin");
}

function ourLauncher(d: CliInstallDeps): string {
  return path.posix.join(binDirOf(d), "turbodl");
}

function sameEntry(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function entries(value: string): string[] {
  return value.split(";").filter((e) => e.trim() !== "");
}

/** `path` with `entry` appended once (compared ignoring case and a trailing backslash) */
export function withEntry(value: string, entry: string): string {
  const list = entries(value);
  if (list.some((e) => sameEntry(e, entry))) return value;
  return [...list, entry].join(";");
}

/** `path` without `entry` (any spelling of it) */
export function withoutEntry(value: string, entry: string): string {
  return entries(value)
    .filter((e) => !sameEntry(e, entry))
    .join(";");
}

export interface UserPath {
  type: "REG_SZ" | "REG_EXPAND_SZ";
  value: string;
}

/** The output of USER_PATH_SCRIPT → the PATH value and its type; "none" when there is no value; null when it can't be read. */
export function parseUserPath(out: string): UserPath | "none" | null {
  const text = out.trim();
  if (text === "none") return "none";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64").toString("utf16le");
  const nl = decoded.indexOf("\n");
  if (nl < 0) return null;
  const kind = decoded.slice(0, nl);
  if (kind !== "ExpandString" && kind !== "String") return null;
  return { type: kind === "String" ? "REG_SZ" : "REG_EXPAND_SZ", value: decoded.slice(nl + 1) };
}

const UNREADABLE: Result = { ok: false, error: "Couldn't read your PATH; nothing was changed." };

/** The user PATH; "none" when there is no value; null when it could not be read (never treat that as empty). */
async function readPath(d: CliInstallDeps): Promise<UserPath | "none" | null> {
  try {
    return parseUserPath(await d.readUserPath());
  } catch {
    return null;
  }
}

/** Rewrites the user PATH with `edit` and tells running programs; nothing is written when `edit` changes nothing or the read failed. */
async function editPath(d: CliInstallDeps, edit: (value: string, binDir: string) => string, only?: (value: string, binDir: string) => boolean): Promise<Result> {
  const found = await readPath(d);
  if (found === null) return UNREADABLE;
  const before = found === "none" ? "" : found.value;
  const binDir = binDirOf(d);
  if (only && !only(before, binDir)) return { ok: true };
  const after = edit(before, binDir);
  if (after === before) return { ok: true };
  await d.runReg(["add", ENV_KEY, "/v", "Path", "/t", found === "none" ? "REG_EXPAND_SZ" : found.type, "/d", after, "/f"]);
  await d.broadcast();
  return { ok: true };
}

function hasEntry(value: string, entry: string): boolean {
  return entries(value).some((e) => sameEntry(e, entry));
}

function failure(err: unknown, platform: NodeJS.Platform): Result {
  const stderr = String((err as { stderr?: string }).stderr ?? "");
  if (platform === "darwin") {
    if (/-128|User cancel/i.test(stderr + String((err as Error)?.message ?? ""))) return { ok: false, error: "Cancelled." };
    return { ok: false, error: stderr.split(/\r?\n/).find((l) => l.trim()) ?? "Couldn't change /usr/local/bin/turbodl." };
  }
  return { ok: false, error: stderr.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? "Couldn't change your PATH." };
}

/** Whether `turbodl` is on the PATH (Windows) or linked into /usr/local/bin (macOS). */
export async function cliStatus(d: CliInstallDeps): Promise<CliStatus> {
  if (!d.supported) return { supported: false, installed: false, where: "" };
  if (d.platform === "win32") {
    const binDir = binDirOf(d);
    const found = await readPath(d);
    return { supported: true, installed: found !== null && found !== "none" && hasEntry(found.value, binDir), where: binDir };
  }
  return { supported: true, installed: d.linkTarget(LINK) === ourLauncher(d), where: LINK };
}

/** Puts the launcher's folder on the user PATH (Windows) or links it into /usr/local/bin (macOS). */
export async function installCli(d: CliInstallDeps): Promise<Result> {
  if (!d.supported) return UNAVAILABLE;
  try {
    if (d.platform === "win32") return await editPath(d, withEntry);
    await d.runAdmin(`mkdir -p /usr/local/bin && ln -sf ${shQuote(ourLauncher(d))} ${LINK}`);
    return { ok: true };
  } catch (err) {
    return failure(err, d.platform);
  }
}

/** Takes our PATH entry (Windows) or our link (macOS) away again. */
export async function removeCli(d: CliInstallDeps): Promise<Result> {
  if (!d.supported) return UNAVAILABLE;
  try {
    if (d.platform === "win32") {
      return await editPath(d, withoutEntry, hasEntry);
    } else {
      const target = d.linkTarget(LINK);
      if (target === null) return { ok: true };
      if (target !== ourLauncher(d)) return { ok: false, error: `${LINK} belongs to another program.` };
      await d.runAdmin(`rm -f ${LINK}`);
    }
    return { ok: true };
  } catch (err) {
    return failure(err, d.platform);
  }
}
