import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { EXTENSION_DIR } from "../../extension/e2e/fixtures";
import { startSiteServer } from "../../extension/e2e/servers";
import { registerNativeHost } from "../src/main/native-host";
import { freePort, httpGet } from "./helpers";

/** Newest installed Opera (its launcher starts a versioned opera.exe that Playwright needs directly). */
function operaExe(): string | null {
  const base = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Opera");
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).filter((d) => /^\d+(\.\d+)+$/.test(d) && existsSync(path.join(base, d, "opera.exe")));
  const newer = (a: string, b: string) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const latest = versions.sort(newer).pop();
  return latest ? path.join(base, latest, "opera.exe") : null;
}

const CHROME_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.turbodl.host";

// Each browser reads a registry key (Opera reads Chrome's); the test backs it up and puts it back.
const BROWSERS = [
  { name: "Chromium", channel: "chromium", register: "Chromium", key: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.turbodl.host" },
  { name: "Edge", channel: "msedge", register: "Edge", key: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.turbodl.host" },
  { name: "Opera", executablePath: operaExe(), register: "Chrome", key: CHROME_KEY },
];

function readKey(key: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return /REG_SZ\s+(.+)\r?\n/.exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function restoreKey(key: string, previous: string | null): void {
  if (previous) execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", previous, "/f"], { windowsHide: true, stdio: "ignore" });
  else execFileSync("reg", ["delete", key, "/f"], { windowsHide: true, stdio: "ignore" });
}

function killListener(port: number): void {
  const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
  const pid = out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((cols) => cols[1] === `127.0.0.1:${port}` && cols[3] === "LISTENING")?.[4];
  if (pid) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

test.skip(process.platform !== "win32", "registry-based native messaging is exercised on Windows");

for (const browser of BROWSERS) {
  test(`${browser.name}: with TurboDL closed, the video button starts it through the native host and hands the video over`, async () => {
    test.skip(browser.executablePath === null, `${browser.name} is not installed`);
    const userData = mkdtempSync(path.join(os.tmpdir(), "turbodl-nm-"));
    const port = await freePort();
    mkdirSync(path.join(userData, "downloads"), { recursive: true });
    writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ bridgePort: port, baseDir: path.join(userData, "downloads") }));
    const appDir = path.join(__dirname, "..");
    const electronExe = createRequire(__filename)("electron") as string;
    const previous = readKey(browser.key);
    await registerNativeHost({
      platform: "win32",
      userDataDir: userData,
      homeDir: os.homedir(),
      execPath: electronExe,
      hostScript: path.join(appDir, "resources", "native-host", "host.cjs"),
      launchArgs: [appDir],
      only: [browser.register],
    });
    const site = await startSiteServer();
    const context = await chromium.launchPersistentContext("", {
      ...(browser.channel ? { channel: browser.channel } : { executablePath: browser.executablePath! }),
      env: { ...process.env, TURBODL_USER_DATA: userData },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    try {
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent("serviceworker");
      await sw.evaluate((p) => chrome.storage.local.set({ port: p }), port);
      await expect(httpGet(port, "/v1/ping")).rejects.toThrow();

      const page = await context.newPage();
      await page.goto(site.url("/video.html"));
      const box = await page.locator("#v").boundingBox();
      const button = page.getByRole("button", { name: "⬇ TurboDL" });
      await expect(async () => {
        await page.mouse.move(box!.x + 100 + Math.random() * 40, box!.y + 120);
        await expect(button).toBeVisible({ timeout: 500 });
      }).toPass({ timeout: 10_000 });
      // the label changes after the click, so follow the element itself rather than its name
      const sendButton = await button.elementHandle();
      await button.click();
      await expect.poll(() => sendButton!.textContent(), { timeout: 40_000 }).toBe("✓ Sent");
      expect((await httpGet(port, "/v1/ping")).status).toBe(200);
    } finally {
      // stop the app first: it was started from inside Playwright's browser and keeps the browser's pipes open
      killListener(port);
      await context.close();
      restoreKey(browser.key, previous);
      await site.close();
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
}
