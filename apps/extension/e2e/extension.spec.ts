import { EXTENSION_ID, expect, test } from "./fixtures";

const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

test("loads with the pinned extension id", async ({ sw }) => {
  expect(new URL(sw.url()).host).toBe(EXTENSION_ID);
});

test("popup reaches the app over loopback with the extension origin", async ({ context, bridge }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(popup.locator("#status")).toHaveText("Connected");
  expect(bridge.requests.find((r) => r.path === "/v1/ping")?.origin).toBe(ORIGIN);
});

// Download capture itself is covered by src/capture.test.ts: on some machines no test
// browser creates download items for link clicks, so it cannot be driven end to end here.

test("detects page media and sends it from the video button", async ({ context, sw, bridge, site }) => {
  const page = await context.newPage();
  await page.goto(site.url("/video.html"));
  await expect
    .poll(
      () =>
        sw.evaluate(async () => {
          const all = await chrome.storage.session.get(null);
          return (Object.values(all) as { kind: string }[][]).flat().map((m) => m.kind).sort().join(",");
        }),
      { timeout: 15_000 },
    )
    .toBe("file,hls");

  const box = await page.locator("#v").boundingBox();
  const button = page.getByRole("button", { name: "⬇ TurboDL" });
  // the content script is injected at document_idle; keep hovering until it reacts
  await expect(async () => {
    await page.mouse.move(box!.x + 100 + Math.random() * 40, box!.y + 120);
    await expect(button).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await button.click();
  await expect.poll(() => bridge.requests.filter((r) => r.path === "/v1/media").length, { timeout: 10_000 }).toBe(1);
  const body = bridge.requests.find((r) => r.path === "/v1/media")!.body;
  expect(body.pageUrl).toBe(site.url("/video.html"));
  expect(body.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["file", "hls"]);
  await expect(page.getByRole("button", { name: "✓ Sent" })).toBeVisible();
});
