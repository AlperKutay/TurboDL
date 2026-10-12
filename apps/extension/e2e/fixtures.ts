import path from "node:path";
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";
import { startMockBridge, startSiteServer, type MockBridge, type SiteServer } from "./servers";

export const EXTENSION_DIR = path.join(__dirname, "..", "dist");
export const EXTENSION_ID = "fnkkncklkbdmaphmmddfmbcjkllejhea";

export async function launchWithExtension(): Promise<{ context: BrowserContext; sw: Worker }> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  return { context, sw };
}

type Fixtures = { context: BrowserContext; sw: Worker; bridge: MockBridge; site: SiteServer };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const { context } = await launchWithExtension();
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw);
  },
  bridge: async ({ sw }, use) => {
    const bridge = await startMockBridge(`chrome-extension://${EXTENSION_ID}`);
    await sw.evaluate((port) => chrome.storage.local.set({ port }), bridge.port);
    await use(bridge);
    await bridge.close();
  },
  // eslint-disable-next-line no-empty-pattern
  site: async ({}, use) => {
    const site = await startSiteServer();
    await use(site);
    await site.close();
  },
});

export const expect = test.expect;
