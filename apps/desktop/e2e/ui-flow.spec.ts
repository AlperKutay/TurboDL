import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

test("adds a URL from the UI, confirms it in the dialog and finishes the download", async () => {
  const server = await startTestServer();
  const data = randomBytes(3 * 1024 * 1024);
  server.setFile("/files/report.pdf", { data, contentType: "application/pdf", throttle: 4 * 1024 * 1024 });
  const { app, userData, baseDir } = await launchApp();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Add URL" }).click();
    await main.getByPlaceholder("https://…").fill(server.url("/files/report.pdf"));
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = await dialogOpened;
    await expect(dialog.getByLabel("File name")).toHaveValue("report.pdf");
    await expect(dialog.getByText("Documents", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Download now", exact: true }).click();

    const row = main.locator("tr[data-status='completed']");
    await expect(row).toContainText("report.pdf", { timeout: 30_000 });
    const file = path.join(baseDir, "Documents", "report.pdf");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(data)).toBe(true);

    await row.click({ button: "right" });
    await expect(main.getByRole("menu")).toContainText("Show in folder");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a copied download link opens the confirmation window, and Ctrl+V adds a link in the main window", async () => {
  const server = await startTestServer();
  server.setFile("/files/copy.zip", { data: randomBytes(1024), contentType: "application/zip" });
  server.setFile("/files/notes.txt", { data: randomBytes(1024), contentType: "text/plain" });
  const { app, userData } = await launchApp();
  // the system clipboard is the user's: put back what was there
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const main = await app.firstWindow();
    await expect(main.getByRole("button", { name: "Add URL" })).toBeVisible();

    let dialogOpened = app.waitForEvent("window");
    await app.evaluate(({ clipboard }, url) => clipboard.writeText(url), server.url("/files/copy.zip"));
    let dialog = await dialogOpened;
    await expect(dialog.getByLabel("File name")).toHaveValue("copy.zip");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // .txt is not on the capture list, so only the explicit paste adds it
    await app.evaluate(({ clipboard }, url) => clipboard.writeText(url), server.url("/files/notes.txt"));
    await main.bringToFront();
    await main.locator(".content").click({ position: { x: 5, y: 5 } });
    dialogOpened = app.waitForEvent("window");
    await main.keyboard.press("Control+V");
    dialog = await dialogOpened;
    await expect(dialog.getByLabel("File name")).toHaveValue("notes.txt");
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved).catch(() => undefined);
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
