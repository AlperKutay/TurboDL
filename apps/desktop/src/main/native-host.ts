import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "@turbodl/shared";

/** Chromium browsers whose extension can start the app: Windows registry key and macOS Application Support folder. */
export const BROWSERS = [
  { name: "Chrome", winKey: "Google\\Chrome", macDir: "Google/Chrome" },
  { name: "Edge", winKey: "Microsoft\\Edge", macDir: "Microsoft Edge" },
  { name: "Brave", winKey: "BraveSoftware\\Brave-Browser", macDir: "BraveSoftware/Brave-Browser" },
  { name: "Chromium", winKey: "Chromium", macDir: "Chromium" },
] as const;

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function hostManifest(launcherPath: string): NativeHostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: "TurboDL: lets the extension start the app",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`${EXTENSION_ORIGIN}/`],
  };
}

const PROFILE_VARS = ["LOCALAPPDATA", "APPDATA", "USERPROFILE"] as const;

/**
 * A path for a .bat file. cmd.exe reads batch files in the console code page, so the
 * (often non-ASCII) profile part is written as an environment variable when possible.
 */
function batPath(value: string, env: NodeJS.ProcessEnv): string {
  for (const name of PROFILE_VARS) {
    const prefix = env[name];
    if (prefix && value.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) {
      return `"%${name}%${value.slice(prefix.length).replace(/%/g, "%%")}"`;
    }
  }
  return `"${value.replace(/%/g, "%%")}"`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launcherScript(
  platform: NodeJS.Platform,
  execPath: string,
  hostScript: string,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts = [execPath, hostScript, ...launchArgs.map((a) => `--launch-arg=${a}`)];
  if (platform === "win32") {
    const command = `${parts.map((p) => batPath(p, env)).join(" ")} %*`;
    const utf8 = /[^\x00-\x7f]/.test(command) ? ["chcp 65001 >nul"] : [];
    return [`@echo off`, ...utf8, "set ELECTRON_RUN_AS_NODE=1", command, ""].join("\r\n");
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${parts.map(shQuote).join(" ")} "$@"\n`;
}

export function regAddArgs(winKey: string, manifestPath: string): string[] {
  return ["add", `HKCU\\Software\\${winKey}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

function runRegExe(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("reg", args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

export interface RegisterOptions {
  platform: NodeJS.Platform;
  userDataDir: string;
  homeDir: string;
  /** the TurboDL executable that runs host.cjs in Node mode */
  execPath: string;
  hostScript: string;
  launchArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** limit to these browser names (tests) */
  only?: string[];
  runReg?: (args: string[]) => Promise<void>;
}

/** Writes the launcher and manifest under userData and registers them with the browsers. Idempotent. */
export async function registerNativeHost(o: RegisterOptions): Promise<{ manifestPath: string; registered: string[] }> {
  const win = o.platform === "win32";
  const dir = path.join(o.userDataDir, "native-host");
  await fsp.mkdir(dir, { recursive: true });
  const launcher = path.join(dir, win ? "turbodl-host.bat" : "turbodl-host.sh");
  await fsp.writeFile(launcher, launcherScript(o.platform, o.execPath, o.hostScript, o.launchArgs, o.env ?? process.env));
  if (!win) await fsp.chmod(launcher, 0o755);
  const manifest = `${JSON.stringify(hostManifest(launcher), null, 2)}\n`;
  const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
  await fsp.writeFile(manifestPath, manifest);

  const browsers = BROWSERS.filter((b) => !o.only || o.only.includes(b.name));
  const registered: string[] = [];
  for (const b of browsers) {
    try {
      if (win) {
        await (o.runReg ?? runRegExe)(regAddArgs(b.winKey, manifestPath));
      } else {
        const support = path.join(o.homeDir, "Library", "Application Support", b.macDir);
        if (!existsSync(support)) continue;
        const hosts = path.join(support, "NativeMessagingHosts");
        await fsp.mkdir(hosts, { recursive: true });
        await fsp.writeFile(path.join(hosts, `${NATIVE_HOST_NAME}.json`), manifest);
      }
      registered.push(b.name);
    } catch {
      // a browser we cannot register for keeps the old behaviour (downloads stay in the browser)
    }
  }
  return { manifestPath, registered };
}

/** Started by the extension through the native host: stay in the tray. */
export function isBackgroundLaunch(argv: string[]): boolean {
  return argv.includes("--hidden");
}
