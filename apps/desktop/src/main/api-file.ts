import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API_FILE, API_VERSION, type ApiFile, type ApiLaunch } from "@turbodl/shared";

const TOKEN = /^[0-9a-f]{64}$/;

function existingToken(file: string): string | null {
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }).token;
    return typeof token === "string" && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Writes api.json (keeping an existing token) so command-line and script clients can find and start the app. */
export function writeApiFile(o: {
  userDataDir: string;
  version: string;
  port: number | null;
  launch: ApiLaunch;
  platform?: NodeJS.Platform;
}): ApiFile {
  const file = path.join(o.userDataDir, API_FILE);
  const data: ApiFile = {
    api: API_VERSION,
    version: o.version,
    port: o.port,
    token: existingToken(file) ?? randomBytes(32).toString("hex"),
    launch: o.launch
  };
  // clients poll the file while the app starts, so they must never see it half-written
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2));
  if ((o.platform ?? process.platform) === "darwin") chmodSync(temp, 0o600);
  renameSync(temp, file);
  return data;
}

/** How clients start this app in the background (the same rule as host.cjs's launchSpec). */
export function clientLaunch(o: { platform: NodeJS.Platform; execPath: string; isPackaged: boolean; appPath: string }): ApiLaunch {
  const bundle = o.platform === "darwin" && o.isPackaged ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(o.execPath) : null;
  if (bundle) return { file: "open", args: ["-g", "-a", bundle[1], "--args", "--hidden"] };
  return { file: o.execPath, args: o.isPackaged ? ["--hidden"] : [o.appPath, "--hidden"] };
}
