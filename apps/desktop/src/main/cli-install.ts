import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
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
      } catch {
        // a running command keeps its file locked; the old launcher reads the same config
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
  /** reg.exe, its stdout */
  runReg(args: string[]): Promise<string>;
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

const BROADCAST_SCRIPT = "[Environment]::SetEnvironmentVariable('TURBODL_PATH_REFRESH','1','User'); [Environment]::SetEnvironmentVariable('TURBODL_PATH_REFRESH',$null,'User')";

/** The real reg.exe, PowerShell, osascript and readlink. */
export function realCliDeps(o: { platform: NodeJS.Platform; userDataDir: string; supported: boolean }): CliInstallDeps {
  return {
    ...o,
    runReg: (args) => run("reg", args),
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

/** `reg query HKCU\Environment /v Path` output → its type and raw value */
export function parseRegQuery(out: string): { type: "REG_SZ" | "REG_EXPAND_SZ"; value: string } | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+Path\s{4}(REG_EXPAND_SZ|REG_SZ)(?:\s{4}(.*))?$/i.exec(line);
    if (m) return { type: m[1].toUpperCase() as "REG_SZ" | "REG_EXPAND_SZ", value: m[2] ?? "" };
  }
  return null;
}

async function readPath(d: CliInstallDeps): Promise<{ type: "REG_SZ" | "REG_EXPAND_SZ"; value: string } | null> {
  try {
    return parseRegQuery(await d.runReg(["query", ENV_KEY, "/v", "Path"]));
  } catch {
    return null;
  }
}

/** Rewrites the user PATH with `edit`, and tells running programs when it changed. */
async function editPath(d: CliInstallDeps, edit: (value: string, binDir: string) => string): Promise<void> {
  const found = await readPath(d);
  const before = found?.value ?? "";
  const after = edit(before, binDirOf(d));
  if (after === before) return;
  await d.runReg(["add", ENV_KEY, "/v", "Path", "/t", found?.type ?? "REG_EXPAND_SZ", "/d", after, "/f"]);
  await d.broadcast();
}

function failure(err: unknown): Result {
  const text = String((err as { stderr?: string }).stderr ?? "") + String((err as Error)?.message ?? "");
  if (/-128|User cancel/i.test(text)) return { ok: false, error: "Cancelled." };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Whether `turbodl` is on the PATH (Windows) or linked into /usr/local/bin (macOS). */
export async function cliStatus(d: CliInstallDeps): Promise<CliStatus> {
  if (!d.supported) return { supported: false, installed: false, where: "" };
  if (d.platform === "win32") {
    const binDir = binDirOf(d);
    const found = await readPath(d);
    return { supported: true, installed: Boolean(found && entries(found.value).some((e) => sameEntry(e, binDir))), where: binDir };
  }
  return { supported: true, installed: d.linkTarget(LINK) === ourLauncher(d), where: LINK };
}

/** Puts the launcher's folder on the user PATH (Windows) or links it into /usr/local/bin (macOS). */
export async function installCli(d: CliInstallDeps): Promise<Result> {
  if (!d.supported) return UNAVAILABLE;
  try {
    if (d.platform === "win32") await editPath(d, withEntry);
    else await d.runAdmin(`mkdir -p /usr/local/bin && ln -sf ${shQuote(ourLauncher(d))} ${LINK}`);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/** Takes our PATH entry (Windows) or our link (macOS) away again. */
export async function removeCli(d: CliInstallDeps): Promise<Result> {
  if (!d.supported) return UNAVAILABLE;
  try {
    if (d.platform === "win32") {
      await editPath(d, withoutEntry);
    } else {
      const target = d.linkTarget(LINK);
      if (target === null) return { ok: true };
      if (target !== ourLauncher(d)) return { ok: false, error: `${LINK} belongs to another program.` };
      await d.runAdmin(`rm -f ${LINK}`);
    }
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
