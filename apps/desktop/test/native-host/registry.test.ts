import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firefoxHostManifest, hostManifest, isBackgroundLaunch, launcherScript, regAddArgs, registerNativeHost } from "../../src/main/native-host";

const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea/";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-nh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hostManifest", () => {
  it("allows only the TurboDL extension", () => {
    expect(hostManifest("C:\\x\\turbodl-host.bat")).toEqual({
      name: "com.turbodl.host",
      description: "TurboDL: lets the extension start the app",
      path: "C:\\x\\turbodl-host.bat",
      type: "stdio",
      allowed_origins: [ORIGIN],
    });
  });
});

describe("launcherScript", () => {
  it("runs the app executable as Node on Windows and passes the browser's arguments on", () => {
    expect(launcherScript("win32", "D:\\TurboDL\\TurboDL.exe", "D:\\TurboDL\\resources\\native-host\\host.cjs", [], {})).toBe(
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"D:\\TurboDL\\TurboDL.exe" "D:\\TurboDL\\resources\\native-host\\host.cjs" %*\r\n',
    );
  });

  it("refers to the profile through environment variables so non-ASCII user names survive cmd.exe", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\Zoë\\AppData\\Local", USERPROFILE: "C:\\Users\\Zoë" };
    const script = launcherScript(
      "win32",
      "C:\\Users\\Zoë\\AppData\\Local\\Programs\\TurboDL\\TurboDL.exe",
      "C:\\Users\\Zoë\\AppData\\Local\\Programs\\TurboDL\\resources\\native-host\\host.cjs",
      [],
      env,
    );
    expect(script).toContain('"%LOCALAPPDATA%\\Programs\\TurboDL\\TurboDL.exe"');
    expect(/^[\x00-\x7f]*$/.test(script)).toBe(true);
  });

  it("escapes percent signs and switches cmd.exe to UTF-8 when a path stays non-ASCII", () => {
    const script = launcherScript("win32", "D:\\100%\\Ærø\\TurboDL.exe", "D:\\h.cjs", [], {});
    expect(script).toContain('"D:\\100%%\\Ærø\\TurboDL.exe"');
    expect(script.split("\r\n")[1]).toBe("chcp 65001 >nul");
  });

  it("puts the AppImage flag right after the script, before launch arguments", () => {
    expect(launcherScript("linux", "/a.AppImage", "/h.cjs", ["/dev app"], {}, true)).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/a.AppImage' '/h.cjs' '--no-sandbox' '--launch-arg=/dev app' "$@"\n`,
    );
  });

  it("quotes paths for /bin/sh on macOS, including apostrophes", () => {
    expect(launcherScript("darwin", "/Users/sam/O'Brien/TurboDL.app/Contents/MacOS/TurboDL", "/x/host.cjs", ["/dev app"])).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/Users/sam/O'\\''Brien/TurboDL.app/Contents/MacOS/TurboDL' '/x/host.cjs' '--launch-arg=/dev app' "$@"\n`,
    );
  });
});

describe("registerNativeHost", () => {
  it("writes the launcher and manifests and registers them for the Chromium browsers and Firefox on Windows", async () => {
    const calls: string[][] = [];
    const userData = path.join(root, "user");
    const result = await registerNativeHost({
      platform: "win32",
      userDataDir: userData,
      homeDir: root,
      execPath: "D:\\TurboDL\\TurboDL.exe",
      hostScript: "D:\\TurboDL\\resources\\native-host\\host.cjs",
      env: {},
      runReg: async (args) => {
        calls.push(args);
        if (args[1].includes("BraveSoftware")) throw new Error("access denied");
      },
    });
    const manifestPath = path.join(userData, "native-host", "com.turbodl.host.json");
    const firefoxManifestPath = path.join(userData, "native-host", "firefox", "com.turbodl.host.json");
    expect(result).toEqual({ manifestPath, firefoxManifestPath, registered: ["Chrome", "Edge", "Vivaldi", "Chromium", "Firefox"] });
    expect(JSON.parse(readFileSync(firefoxManifestPath, "utf8"))).toEqual(firefoxHostManifest(path.join(userData, "native-host", "turbodl-host.bat")));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.path).toBe(path.join(userData, "native-host", "turbodl-host.bat"));
    expect(readFileSync(manifest.path, "utf8")).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(calls).toEqual([
      regAddArgs("Google\\Chrome", manifestPath),
      regAddArgs("Microsoft\\Edge", manifestPath),
      regAddArgs("BraveSoftware\\Brave-Browser", manifestPath),
      regAddArgs("Vivaldi", manifestPath),
      regAddArgs("Chromium", manifestPath),
      regAddArgs("Mozilla", firefoxManifestPath),
    ]);
    expect(calls[0]).toEqual(["add", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.turbodl.host", "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  });

  it("can register a single browser", async () => {
    const calls: string[][] = [];
    await registerNativeHost({
      platform: "win32",
      userDataDir: root,
      homeDir: root,
      execPath: "e.exe",
      hostScript: "h.cjs",
      env: {},
      only: ["Chromium"],
      runReg: async (args) => void calls.push(args),
    });
    expect(calls.map((c) => c[1])).toEqual(["HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.turbodl.host"]);
  });

  it("puts the manifest into the NativeMessagingHosts folder of installed browsers on macOS", async () => {
    const support = path.join(root, "Library", "Application Support");
    mkdirSync(path.join(support, "Google", "Chrome"), { recursive: true });
    mkdirSync(path.join(support, "Microsoft Edge"), { recursive: true });
    mkdirSync(path.join(support, "com.operasoftware.Opera"), { recursive: true });
    // Firefox keeps its profiles in "Firefox" but reads native hosts from "Mozilla"
    mkdirSync(path.join(support, "Firefox"), { recursive: true });
    const result = await registerNativeHost({
      platform: "darwin",
      userDataDir: path.join(root, "user"),
      homeDir: root,
      execPath: "/Applications/TurboDL.app/Contents/MacOS/TurboDL",
      hostScript: "/Applications/TurboDL.app/Contents/Resources/native-host/host.cjs",
    });
    expect(result.registered).toEqual(["Chrome", "Edge", "Opera", "Firefox"]);
    expect(existsSync(path.join(support, "com.operasoftware.Opera", "NativeMessagingHosts", "com.turbodl.host.json"))).toBe(true);
    const firefox = JSON.parse(readFileSync(path.join(support, "Mozilla", "NativeMessagingHosts", "com.turbodl.host.json"), "utf8"));
    expect(firefox.allowed_extensions).toEqual(["turbodl@turbodl.app"]);
    expect(firefox).not.toHaveProperty("allowed_origins");
    const chrome = JSON.parse(readFileSync(path.join(support, "Google", "Chrome", "NativeMessagingHosts", "com.turbodl.host.json"), "utf8"));
    expect(chrome.allowed_origins).toEqual([ORIGIN]);
    expect(chrome.path.endsWith("turbodl-host.sh")).toBe(true);
    expect(existsSync(path.join(support, "BraveSoftware"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(chrome.path).mode & 0o111).not.toBe(0);
  });

  it("puts the manifest into the NativeMessagingHosts folder of installed browsers on Linux", async () => {
    mkdirSync(path.join(root, ".config", "google-chrome"), { recursive: true });
    mkdirSync(path.join(root, ".config", "BraveSoftware", "Brave-Browser"), { recursive: true });
    mkdirSync(path.join(root, ".mozilla"), { recursive: true });
    const result = await registerNativeHost({
      platform: "linux",
      userDataDir: path.join(root, "user"),
      homeDir: root,
      execPath: "/opt/TurboDL/turbodl-app",
      hostScript: "/opt/TurboDL/resources/native-host/host.cjs",
      env: {},
    });
    expect(result.registered).toEqual(["Chrome", "Brave", "Firefox"]);
    const chrome = JSON.parse(readFileSync(path.join(root, ".config", "google-chrome", "NativeMessagingHosts", "com.turbodl.host.json"), "utf8"));
    expect(chrome.allowed_origins).toEqual([ORIGIN]);
    expect(chrome.path.endsWith("turbodl-host.sh")).toBe(true);
    const brave = JSON.parse(readFileSync(path.join(root, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", "com.turbodl.host.json"), "utf8"));
    expect(brave.allowed_origins).toEqual([ORIGIN]);
    expect(brave.path.endsWith("turbodl-host.sh")).toBe(true);
    const firefox = JSON.parse(readFileSync(path.join(root, ".mozilla", "native-messaging-hosts", "com.turbodl.host.json"), "utf8"));
    expect(firefox.allowed_extensions).toEqual(["turbodl@turbodl.app"]);
    expect(existsSync(path.join(root, ".config", "chromium"))).toBe(false);
    expect(readFileSync(chrome.path, "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/TurboDL/turbodl-app' '/opt/TurboDL/resources/native-host/host.cjs' "$@"\n`,
    );
  });

  it("follows XDG_CONFIG_HOME and finds Firefox installed from Snap", async () => {
    const cfg = path.join(root, "cfg");
    mkdirSync(path.join(cfg, "vivaldi"), { recursive: true });
    mkdirSync(path.join(root, "snap", "firefox", "common", ".mozilla"), { recursive: true });
    const result = await registerNativeHost({
      platform: "linux",
      userDataDir: path.join(root, "user"),
      homeDir: root,
      execPath: "/opt/TurboDL/turbodl-app",
      hostScript: "/opt/TurboDL/resources/native-host/host.cjs",
      env: { XDG_CONFIG_HOME: cfg },
    });
    expect(result.registered).toEqual(["Vivaldi", "Firefox"]);
    expect(existsSync(path.join(cfg, "vivaldi", "NativeMessagingHosts", "com.turbodl.host.json"))).toBe(true);
    expect(existsSync(path.join(root, ".mozilla", "native-messaging-hosts", "com.turbodl.host.json"))).toBe(true);
    expect(existsSync(path.join(root, ".config"))).toBe(false);
  });

  it("runs a copy of host.cjs through the AppImage file, with the flag after the script", async () => {
    const hostScript = path.join(root, "host-original.cjs");
    writeFileSync(hostScript, "// host");
    mkdirSync(path.join(root, ".config", "google-chrome"), { recursive: true });
    const userData = path.join(root, "user");
    await registerNativeHost({
      platform: "linux",
      userDataDir: userData,
      homeDir: root,
      execPath: "/tmp/.mount_x/turbodl-app",
      hostScript,
      env: { APPIMAGE: "/home/a/My Apps/TurboDL.AppImage", APPDIR: "/tmp/.mount_x" },
    });
    const copy = path.join(userData, "native-host", "host.cjs");
    expect(readFileSync(copy, "utf8")).toBe("// host");
    expect(readFileSync(path.join(userData, "native-host", "turbodl-host.sh"), "utf8")).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/home/a/My Apps/TurboDL.AppImage' '${copy}' '--no-sandbox' "$@"\n`,
    );
  });
});

describe("firefoxHostManifest", () => {
  it("lets only the Firefox build of the extension start the app", () => {
    expect(firefoxHostManifest("/x/turbodl-host.sh")).toEqual({
      name: "com.turbodl.host",
      description: "TurboDL: lets the extension start the app",
      path: "/x/turbodl-host.sh",
      type: "stdio",
      allowed_extensions: ["turbodl@turbodl.app"],
    });
  });
});

describe("isBackgroundLaunch", () => {
  it("recognises a start from the browser, which must not pop up the main window", () => {
    expect(isBackgroundLaunch(["TurboDL.exe", "--hidden"])).toBe(true);
    expect(isBackgroundLaunch(["TurboDL.exe"])).toBe(false);
  });

  it("treats a start by a notification click (COM activation) as a background start", () => {
    expect(isBackgroundLaunch(["TurboDL.exe", "-Embedding"])).toBe(true);
  });
});
