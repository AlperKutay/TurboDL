import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API_FILE, API_VERSION, type ApiFile, type ApiLaunch } from "@turbodl/shared";

import { appLocation } from "./app-location";

const TOKEN =/^[0-9a-f]{64}$/;
/** more tries of the rename while a client reading api.json holds it (Windows), and ms between them */
const RENAME_RETRIES = 3;
const RENAME_GAP = 50;

function existingToken(file: string): string | null {
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }).token;
    return typeof token === "string" && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The token api.json holds, or a new one when it has none; the file is not written. */
export function apiToken(userDataDir: string): string {
  return existingToken(path.join(userDataDir, API_FILE)) ?? randomBytes(32).toString("hex");
}

/**
 * Writes api.json (keeping an existing token, or using `token`) so command-line and script clients can find and start
 * the app; `error`, the app's own message, goes with `port: null`. `rename` and `wait` stand in for the file system's
 * and the clock's in tests.
 */
export async function writeApiFile(o: {
  userDataDir: string;
  version: string;
  port: number | null;
  error?: string;
  launch: ApiLaunch;
  token?: string;
  rename?: (from: string, to: string) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<ApiFile> {
  const file = path.join(o.userDataDir, API_FILE);
  const data: ApiFile = {
    api: API_VERSION,
    version: o.version,
    port: o.port,
    ...(o.port === null && o.error ? { error: o.error } : {}),
    token: o.token ?? apiToken(o.userDataDir),
    launch: o.launch,
  };
  // clients poll the file while the app starts, so they must never see it half-written; a name of its own per write
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  // readable by the user only (where the system knows file modes) from the moment it exists
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  const rename = o.rename ?? renameSync;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    for (let retry = 0; ; retry++) {
      try {
        rename(temp, file);
        return data;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (retry >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw err;
        await wait(RENAME_GAP);
      }
    }
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** How clients start this app in the background (the same rule as host.cjs's launchSpec). */
export function clientLaunch(o: {
  platform: NodeJS.Platform;
  execPath: string;
  isPackaged: boolean;
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): ApiLaunch {
  const execPath = appLocation({ platform: o.platform, execPath: o.execPath, env: o.env ?? {} }).file;
  const bundle = o.platform === "darwin" && o.isPackaged ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath) : null;
  if (bundle) return { file: "open", args: ["-g", "-a", bundle[1], "--args", "--hidden"] };
  return { file: execPath, args: o.isPackaged ? ["--hidden"] : [o.appPath, "--hidden"] };
}
