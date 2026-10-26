import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { API_FILE, type ApiFile, type ApiLaunch } from "@turbodl/shared";

/** TURBODL_USER_DATA, else %APPDATA%\TurboDL, ~/Library/Application Support/TurboDL, or ~/.config/TurboDL. */
export function userDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env.TURBODL_USER_DATA) return env.TURBODL_USER_DATA;
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "TurboDL");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "TurboDL");
  return path.join(home, ".config", "TurboDL");
}

/** The parsed api.json in `dir`, or null when it is missing or unreadable. */
export function readApiFile(dir: string): ApiFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, API_FILE), "utf8")) as ApiFile;
    return v && typeof v === "object" && typeof v.token === "string" && v.launch ? v : null;
  } catch {
    return null;
  }
}

export interface Connection {
  port: number;
  token: string;
}

export interface ConnectDeps {
  dir: string;
  spawn(launch: ApiLaunch): void;
  ping(c: Connection): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** how long to wait for the app after starting it; 30000 by default */
  timeoutMs?: number;
}

const NEVER_OPENED = "TurboDL hasn't been opened on this computer yet. Open it once, then try again.";
const PORT_FALLBACK = "TurboDL couldn't open its local port. Pick another port in TurboDL's Settings.";
const POLL_MS = 250;

/** The running app, or the app started from api.json's `launch` and waited for. */
export async function connect(d: ConnectDeps): Promise<Connection | { error: string }> {
  const timeoutMs = d.timeoutMs ?? 30000;
  let file = readApiFile(d.dir);
  if (!file) return { error: NEVER_OPENED };
  if (file.port !== null && (await d.ping({ port: file.port, token: file.token }))) return { port: file.port, token: file.token };

  d.spawn(file.launch);
  const start = d.now();
  let portError: string | undefined;
  while (d.now() - start < timeoutMs) {
    await d.sleep(POLL_MS);
    file = readApiFile(d.dir) ?? file;
    if (file.port === null) {
      portError = file.error || PORT_FALLBACK;
      continue;
    }
    portError = undefined;
    if (await d.ping({ port: file.port, token: file.token })) return { port: file.port, token: file.token };
  }
  return { error: portError ?? "TurboDL didn't start within 30 seconds." };
}

/** Starts the app detached from this process: no stdio, without ELECTRON_RUN_AS_NODE. */
export function spawnDetached(launch: ApiLaunch, env: NodeJS.ProcessEnv): void {
  const clean = { ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  const child = spawn(launch.file, launch.args, { detached: true, stdio: "ignore", env: clean });
  child.on("error", () => undefined);
  child.unref();
}
