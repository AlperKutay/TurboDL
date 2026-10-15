import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { EXTENSION_ORIGIN, FIREFOX_EXTENSION_ID, NATIVE_HOST_NAME } from "@turbodl/shared";

export interface BrowserTarget {
  name: string;
  /** HKCU\Software\<winKey>\NativeMessagingHosts; none: the browser reads Chrome's key (Opera does) */
  winKey?: string;
  /** ~/Library/Application Support/<macDir>/NativeMessagingHosts */
  macDir?: string;
  /** folder whose presence shows the browser is installed, when it differs from macDir */
  macProbe?: string;
  /** Firefox uses its own manifest (allowed_extensions instead of allowed_origins) */
  firefox?: boolean;
}

/** Browsers whose extension can start the app: Windows registry key and macOS Application Support folder. */
export const BROWSERS: readonly BrowserTarget[] = [
  { name: "Chrome", winKey: "Google\\Chrome", macDir: "Google/Chrome" },
  { name: "Edge", winKey: "Microsoft\\Edge", macDir: "Microsoft Edge" },
  { name: "Brave", winKey: "BraveSoftware\\Brave-Browser", macDir: "BraveSoftware/Brave-Browser" },
  { name: "Vivaldi", winKey: "Vivaldi", macDir: "Vivaldi" },
  { name: "Opera", macDir: "com.operasoftware.Opera" },
  { name: "Opera GX", macDir: "com.operasoftware.OperaGX" },
  { name: "Arc", macDir: "Arc/User Data" },
  { name: "Chromium", winKey: "Chromium", macDir: "Chromium" },
  { name: "Firefox", winKey: "Mozilla", macDir: "Mozilla", macProbe: "Firefox", firefox: true },
];

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins?: string[];
  allowed_extensions?: string[];
}

const DESCRIPTION = "TurboDL: lets the extension start the app";

export function hostManifest(launcherPath: string): NativeHostManifest {
  return { name: NATIVE_HOST_NAME, description: DESCRIPTION, path: launcherPath, type: "stdio", allowed_origins: [`${EXTENSION_ORIGIN}/`] };
}

export function firefoxHostManifest(launcherPath: string): NativeHostManifest {
  return { name: NATIVE_HOST_NAME, description: DESCRIPTION, path: launcherPath, type: "stdio", allowed_extensions: [FIREFOX_EXTENSION_ID] };
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

/** Writes the launcher and manifests under userData and registers them with the browsers. Idempotent. */
export async function registerNativeHost(o: RegisterOptions): Promise<{ manifestPath: string; firefoxManifestPath: string; registered: string[] }> {
  const win = o.platform === "win32";
  const dir = path.join(o.userDataDir, "native-host");
  await fsp.mkdir(dir, { recursive: true });
  const launcher = path.join(dir, win ? "turbodl-host.bat" : "turbodl-host.sh");
  await fsp.writeFile(launcher, launcherScript(o.platform, o.execPath, o.hostScript, o.launchArgs, o.env ?? process.env));
  if (!win) await fsp.chmod(launcher, 0o755);
  const manifest = `${JSON.stringify(hostManifest(launcher), null, 2)}\n`;
  const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
  await fsp.writeFile(manifestPath, manifest);
  const firefoxManifest = `${JSON.stringify(firefoxHostManifest(launcher), null, 2)}\n`;
  const firefoxManifestPath = path.join(dir, "firefox", `${NATIVE_HOST_NAME}.json`);
  await fsp.mkdir(path.dirname(firefoxManifestPath), { recursive: true });
  await fsp.writeFile(firefoxManifestPath, firefoxManifest);

  const browsers = BROWSERS.filter((b) => !o.only || o.only.includes(b.name));
  const registered: string[] = [];
  for (const b of browsers) {
    try {
      if (win) {
        if (!b.winKey) continue;
        await (o.runReg ?? runRegExe)(regAddArgs(b.winKey, b.firefox ? firefoxManifestPath : manifestPath));
      } else {
        if (!b.macDir) continue;
        const support = path.join(o.homeDir, "Library", "Application Support");
        if (!existsSync(path.join(support, b.macProbe ?? b.macDir))) continue;
        const hosts = path.join(support, b.macDir, "NativeMessagingHosts");
        await fsp.mkdir(hosts, { recursive: true });
        await fsp.writeFile(path.join(hosts, `${NATIVE_HOST_NAME}.json`), b.firefox ? firefoxManifest : manifest);
      }
      registered.push(b.name);
    } catch {
      // a browser we cannot register for keeps the old behaviour (downloads stay in the browser)
    }
  }
  return { manifestPath, firefoxManifestPath, registered };
}

/** Started by the browser (--hidden) or by a click on a Windows notification (COM activation adds -Embedding). */
export function isBackgroundLaunch(argv: string[]): boolean {
  return argv.includes("--hidden") || argv.includes("-Embedding");
}
