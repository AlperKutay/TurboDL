import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

/** The demo Instagram (TURBODL_INSTAGRAM_DEMO_BASE): demo.person has 6 posts on 2 pages, the first pinned; demo.locked is private. */
async function demo() {
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, "") });
  return { server, ...launched };
}

async function openProfile(main: Page, username: string) {
  await main.getByRole("button", { name: "Profiles", exact: true }).click();
  await main.getByPlaceholder("Profile link or @username").fill(username);
  await main.getByRole("button", { name: "Open", exact: true }).click();
}

test("profiles: opens a profile, picks two posts into its folder", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.person");
    await expect(main.getByText("@demo.person")).toBeVisible({ timeout: 15_000 });
    const tiles = main.getByRole("button", { name: /^Post \d+$/ });
    await expect(tiles).toHaveCount(6, { timeout: 15_000 });
    await expect(main.getByRole("button", { name: "Post 1", exact: true })).toContainText("Pinned");

    await main.getByRole("button", { name: "Post 1", exact: true }).click();
    await main.getByRole("button", { name: "Post 2", exact: true }).click();
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Next (2)" }).click();
    const dialog = await dialogOpened;
    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 2", { timeout: 15_000 });
    await download.click();

    await main.getByRole("button", { name: "All downloads" }).click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(2, { timeout: 30_000 });
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person")).sort()).toEqual(["p1.png", "p2.png"]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: backs a profile up and lists it", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "@demo.person");
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(6, { timeout: 15_000 });
    await main.getByRole("button", { name: "Back up this profile" }).click();
    const confirm = main.getByRole("dialog", { name: "Back up @demo.person" });
    await expect(confirm).toContainText("6 posts");
    await confirm.getByRole("button", { name: "Start backup" }).click();
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person")).sort()).toEqual(["p1.png", "p2.png", "p3.png", "p4.png", "p5.png", "p6.png"]);

    await main.getByRole("button", { name: "All profiles" }).click();
    const row = main.getByRole("listitem").filter({ hasText: "@demo.person" });
    await expect(row).toContainText("6 saved");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: a private profile says so", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.locked");
    await expect(main.getByText("This account is private")).toBeVisible({ timeout: 15_000 });
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(0);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: an open profile stays open across sections; All profiles shows the list", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.person");
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(6, { timeout: 15_000 });
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await expect(main.getByText("@demo.person")).toBeVisible();
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(6);
    await main.getByRole("button", { name: "All profiles" }).click();
    await expect(main.getByPlaceholder("Profile link or @username")).toBeVisible();
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await expect(main.getByPlaceholder("Profile link or @username")).toBeVisible();
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("highlights: picks two highlights, their stories into the highlights folder", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.person");
    await main.getByRole("tab", { name: "Highlights" }).click();
    await main.getByRole("button", { name: "Summer", exact: true }).click();
    await main.getByRole("button", { name: "Winter", exact: true }).click();
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Next (2)" }).click();
    const dialog = await dialogOpened;
    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 4", { timeout: 15_000 });
    await download.click();
    await main.getByRole("button", { name: "All downloads" }).click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(4, { timeout: 30_000 });
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person · Highlights")).sort()).toEqual([
      "h17900000000000002-1.png",
      "h17900000000000002-2.png",
      "h17900000000000003-1.png",
      "h17900000000000003-2.png",
    ]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("highlights: backs them up, and a run again saves nothing new", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.person");
    await main.getByRole("tab", { name: "Highlights" }).click();
    await main.getByRole("button", { name: "Back up highlights" }).click();
    const confirm = main.getByRole("dialog", { name: "Back up @demo.person's highlights" });
    await expect(confirm).toContainText("2 highlights");
    await confirm.getByRole("button", { name: "Start backup" }).click();
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    await expect(panel).toContainText("New 4");
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person · Highlights"))).toHaveLength(4);
    await main.getByRole("button", { name: "Back up highlights" }).click();
    await main.getByRole("dialog", { name: "Back up @demo.person's highlights" }).getByRole("button", { name: "Start backup" }).click();
    await expect(panel).toContainText("New 0", { timeout: 30_000 });
    await expect(panel).toContainText("Backup finished");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("highlights: a profile without any says so", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.plain");
    await main.getByRole("tab", { name: "Highlights" }).click();
    await expect(main.getByText("No highlights")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("highlights: signed out partway through reading says so and offers to sign in again", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.expired");
    await main.getByRole("tab", { name: "Highlights" }).click();
    await main.getByRole("button", { name: "Gone", exact: true }).click();
    await main.getByRole("button", { name: "Next (1)" }).click();
    await expect(main.getByText("Instagram signed TurboDL out.")).toBeVisible({ timeout: 15_000 });
    await expect(main.getByRole("button", { name: "Sign in again" })).toBeVisible();
    // the pick stays for after signing in
    await expect(main.getByRole("button", { name: "Gone", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: each side keeps its picks when switching between Posts and Highlights", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.person");
    await main.getByRole("button", { name: "Post 1", exact: true }).click();
    await main.getByRole("tab", { name: "Highlights" }).click();
    await main.getByRole("button", { name: "Winter", exact: true }).click();
    await main.getByRole("tab", { name: "Posts" }).click();
    await expect(main.getByRole("button", { name: "Post 1", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("button", { name: "Next (1)" })).toBeVisible();
    await main.getByRole("tab", { name: "Highlights" }).click();
    await expect(main.getByRole("button", { name: "Winter", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
