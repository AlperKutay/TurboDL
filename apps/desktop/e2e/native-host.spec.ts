import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { EXTENSION_DIR } from "../../extension/e2e/fixtures";
import { startSiteServer } from "../../extension/e2e/servers";
import { registerNativeHost } from "../src/main/native-host";
import { freePort, httpGet } from "./helpers";

// Each browser reads its own registry key; the test backs it up and puts it back.
const BROWSERS = [
  { name: "Chromium", channel: "chromium", key: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.turbodl.host" },
  { name: "Edge", channel: "msedge", key: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.turbodl.host" },
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
      only: [browser.name],
    });
    const site = await startSiteServer();
    const context = await chromium.launchPersistentContext("", {
      channel: browser.channel,
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
