import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { httpGet, launchApp } from "./helpers";

test("starts, shows the main window and answers the extension", async () => {
  const { app, userData, port } = await launchApp();
  try {
    const win = await app.firstWindow();
    await expect(win.locator("body")).toContainText("TurboDL");
    const ping = await httpGet(port, "/v1/ping");
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body).app).toBe("turbodl");
    const rejected = await httpGet(port, "/v1/ping", "https://evil.example");
    expect(rejected.status).toBe(403);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
