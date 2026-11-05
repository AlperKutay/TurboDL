import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

/**
 * The demo Instagram (TURBODL_INSTAGRAM_DEMO_BASE): demo.person has 6 posts on 2 pages, the first pinned; demo.locked is
 * private; demo.public is seen signed out (7 posts on 3 pages, DP5 shown only to signed-in visitors).
 */
async function demo(env: Record<string, string> = {}) {
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, ""), ...env });
  return { server, ...launched };
}

/** The app's native open dialog answers with `file` at once: e2e can't drive a native dialog, so the main process's is replaced. */
async function stubOpenDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
  }, file);
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
    // at first everything is ticked, tagged posts too (signed in)
    for (const name of ["Posts", "Highlights", "Tagged", "Photos", "Videos"]) await expect(confirm.getByRole("checkbox", { name, exact: true })).toBeChecked();
    await expect(confirm).toContainText("(highlights and tagged posts into folders of their own)");
    await confirm.getByRole("button", { name: "Start backup" }).click();
    await expect(confirm).toBeHidden({ timeout: 15_000 });
    // the parts run in turn (posts, highlights, tagged posts): the last one's end is the backup's
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("demo.person · Tagged", { timeout: 30_000 });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    const root = path.join(baseDir, "Instagram", "demo.person");
    expect(readdirSync(root).sort()).toEqual(["Highlights", "Tagged", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png", "p6.png"]);
    expect(readdirSync(path.join(root, "Highlights"))).toHaveLength(4);
    expect(readdirSync(path.join(root, "Tagged")).sort()).toEqual(["p1.png", "p2.png"]);

    await main.getByRole("button", { name: "All profiles" }).click();
    const row = main.getByRole("listitem").filter({ hasText: "@demo.person" });
    await expect(row).toContainText("12 saved");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: a backup saves the kinds ticked, remembers them, and fetches a kind ticked later for posts saved before", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    // demo.plain: p1 and p3 photos, p2 a video; its tagged page shows p1 and p2
    await openProfile(main, "demo.plain");
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(3, { timeout: 15_000 });
    await main.getByRole("button", { name: "Back up this profile" }).click();
    const confirm = main.getByRole("dialog", { name: "Back up @demo.plain" });
    const start = confirm.getByRole("button", { name: "Start backup" });
    const photos = confirm.getByRole("checkbox", { name: "Photos", exact: true });
    const videos = confirm.getByRole("checkbox", { name: "Videos", exact: true });
    // nothing to save: Start waits for a kind
    await photos.uncheck();
    await videos.uncheck();
    await expect(confirm).toContainText("Pick photos, videos or both.");
    await expect(start).toBeDisabled();
    await photos.check();
    await expect(confirm).not.toContainText("Pick photos, videos or both.");
    await start.click();
    await expect(confirm).toBeHidden({ timeout: 15_000 });
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("demo.plain · Tagged", { timeout: 30_000 });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    // the highlights part (ticked, but there are none) said why it saved nothing; the screen hears of it
    await expect(panel).toContainText("This profile has no highlights.");
    const root = path.join(baseDir, "Instagram", "demo.plain");
    expect(readdirSync(root).sort()).toEqual(["Tagged", "p1.png", "p3.png"]);
    expect(readdirSync(path.join(root, "Tagged"))).toEqual(["p1.png"]);

    // the choice is remembered; Videos ticked now fetches the video of the post saved before, tagged too (the backup
    // without videos finished: nothing to continue)
    await main.getByRole("button", { name: "Back up this profile" }).click();
    await expect(photos).toBeChecked();
    await expect(videos).not.toBeChecked();
    await expect(confirm).not.toContainText("An earlier backup stopped before the end");
    await videos.check();
    await start.click();
    await expect.poll(() => readdirSync(path.join(root, "Tagged")).sort(), { timeout: 30_000 }).toEqual(["p1.png", "p2.mp4"]);
    expect(readdirSync(root).sort()).toEqual(["Tagged", "p1.png", "p2.mp4", "p3.png"]);
    await expect(panel).toContainText("demo.plain · Tagged");
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: backs up a list of profiles from a .txt, one after another", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const file = path.join(userData, "list.txt");
    writeFileSync(file, "# two demo profiles\ndemo.person\nnot a name!\nhttps://www.instagram.com/demo.plain/\n");
    await stubOpenDialog(app, file);
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await main.getByRole("button", { name: "Back up a list…" }).click();
    const dialog = main.getByRole("dialog", { name: "Back up a list" });
    const start = dialog.getByRole("button", { name: "Start", exact: true });
    // nothing chosen yet
    await expect(start).toBeDisabled();
    await dialog.getByRole("button", { name: "Choose a .txt file…" }).click();
    await expect(dialog).toContainText("list.txt · 2 profiles");
    await expect(dialog).toContainText("@demo.person, @demo.plain");
    await expect(dialog).toContainText("Line 3 isn't a profile: not a name!");
    // the wait starts as the last list's (2–5 minutes at first) and must make sense
    const least = dialog.getByRole("spinbutton", { name: "At least" });
    const most = dialog.getByRole("spinbutton", { name: "At most" });
    await expect(least).toHaveValue("2");
    await expect(most).toHaveValue("5");
    await least.fill("6");
    await expect(dialog).toContainText("Waits are whole minutes from 0 to 1440, the most at least the least.");
    await expect(start).toBeDisabled();
    await least.fill("0");
    await most.fill("0");
    await expect(dialog).not.toContainText("Waits are whole minutes");
    await start.click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const panel = main.getByRole("region", { name: "Profile list" });
    await expect(panel).toContainText("list.txt ·");
    await expect(panel).toContainText("Finished: 2 backed up, 0 skipped", { timeout: 90_000 });
    await expect(panel).toContainText("2 of 2");
    await expect(panel.getByRole("button", { name: /^✓ @demo\.person — / })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^✓ @demo\.plain — / })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person")).length).toBeGreaterThan(0);
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.plain")).length).toBeGreaterThan(0);
    // both profiles join the Profiles list; a row opens its profile
    await expect(main.getByRole("listitem").filter({ hasText: "@demo.plain" }).getByRole("button", { name: /saved/ })).toBeVisible();
    await panel.getByRole("button", { name: /^✓ @demo\.plain — / }).click();
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(3, { timeout: 15_000 });
    await main.getByRole("button", { name: "All profiles" }).click();
    // Close forgets the list
    await main.getByRole("region", { name: "Profile list" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(main.getByRole("region", { name: "Profile list" })).toHaveCount(0);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: a list started signed out keeps Tagged off, as its dialog shows it", async () => {
  const { server, app, userData } = await demo({ TURBODL_INSTAGRAM_DEMO_SIGNED_OUT: "1" });
  try {
    const file = path.join(userData, "one.txt");
    writeFileSync(file, "demo.public\n");
    await stubOpenDialog(app, file);
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await main.getByRole("button", { name: "Back up a list…" }).click();
    const dialog = main.getByRole("dialog", { name: "Back up a list" });
    await dialog.getByRole("button", { name: "Choose a .txt file…" }).click();
    await expect(dialog).toContainText("one.txt · 1 profile");
    // remembered ticked (the first use's), shown unticked: it can't be saved signed out
    const tagged = dialog.getByRole("checkbox", { name: "Tagged" });
    await expect(tagged).not.toBeChecked();
    await expect(tagged).toBeDisabled();
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    const stored = () => {
      try {
        return (JSON.parse(readFileSync(path.join(userData, "instagram-profile-list.json"), "utf8")) as { options: unknown }).options;
      } catch {
        return null;
      }
    };
    await expect.poll(stored, { timeout: 5_000 }).toMatchObject({ posts: true, tagged: false });
    await expect(main.getByRole("region", { name: "Profile list" })).toContainText("one.txt ·");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("profiles: a list counts down to its next profile, stops and goes on, and an open profile leads back to it", async () => {
  const { server, app, userData } = await demo();
  try {
    const file = path.join(userData, "two.txt");
    writeFileSync(file, "demo.person\ndemo.plain\n");
    await stubOpenDialog(app, file);
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await main.getByRole("button", { name: "Back up a list…" }).click();
    const dialog = main.getByRole("dialog", { name: "Back up a list" });
    await dialog.getByRole("button", { name: "Choose a .txt file…" }).click();
    await expect(dialog).toContainText("two.txt · 2 profiles");
    await dialog.getByRole("spinbutton", { name: "At least" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "At most" }).fill("1");
    await dialog.getByRole("button", { name: "Start", exact: true }).click();

    // the first profile backed up, a minute's wait before the second, counting down
    const panel = main.getByRole("region", { name: "Profile list" });
    const line = panel.getByText(/^Next profile in \d:\d\d$/);
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText("two.txt · 2 of 2");
    await expect(panel.getByRole("button", { name: /^✓ @demo\.person — / })).toBeVisible();
    await expect(panel.getByRole("button", { name: "· @demo.plain — waiting" })).toBeVisible();
    const first = await line.innerText();
    await expect.poll(() => line.innerText(), { timeout: 5_000 }).not.toBe(first);

    // one list at a time
    await main.getByRole("button", { name: "Back up a list…" }).click();
    await expect(main.getByText("Close the list that is there first.")).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // a profile opened from the list says where the list is, and leads back to it
    await panel.getByRole("button", { name: /^✓ @demo\.person — / }).click();
    const banner = main.getByRole("button", { name: "List: 2 of 2 — @demo.plain" });
    await expect(banner).toBeVisible();
    await banner.click();
    await expect(panel).toBeVisible();

    // Stop: Continue or Close; Continue waits out the rest of the wait
    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(panel).toContainText("Stopped");
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(line).toBeVisible();
    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);
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
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person", "Highlights")).sort()).toEqual([
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
    // the highlights alone: only the kinds are chosen here
    await expect(confirm.getByRole("checkbox", { name: "Photos", exact: true })).toBeChecked();
    await expect(confirm.getByRole("checkbox", { name: "Videos", exact: true })).toBeChecked();
    await expect(confirm.getByRole("checkbox", { name: "Posts", exact: true })).toHaveCount(0);
    await confirm.getByRole("button", { name: "Start backup" }).click();
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    await expect(panel).toContainText("New 4");
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person", "Highlights"))).toHaveLength(4);
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

test("profiles: a public profile opens signed out; picks and a backup read each post from its own page, and a highlight opens", async () => {
  const { server, app, userData, baseDir } = await demo({ TURBODL_INSTAGRAM_DEMO_SIGNED_OUT: "1" });
  try {
    const main = await app.firstWindow();
    await openProfile(main, "demo.public");
    await expect(main.getByText("Seen signed out")).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText("Sign in to Instagram to see this profile's posts.")).toHaveCount(0);
    // the grid pages on signed out, to the profile's end, as the grid's end comes into view
    const tiles = main.getByRole("button", { name: /^Post \d+$/ });
    await expect(async () => {
      await main.locator(".saved-end").scrollIntoViewIfNeeded();
      expect(await tiles.count()).toBe(7);
    }).toPass({ timeout: 15_000 });
    await expect(main.getByRole("button", { name: "Post 1", exact: true })).toContainText("Carousel");
    await expect(main.getByRole("button", { name: "Post 2", exact: true })).toContainText("Video");
    await main.getByRole("button", { name: "Post 1", exact: true }).click();
    await main.getByRole("button", { name: "Post 2", exact: true }).click();
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Next (2)" }).click();
    const dialog = await dialogOpened;
    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 4", { timeout: 15_000 });
    await download.click();
    await main.getByRole("button", { name: "All downloads" }).click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(4, { timeout: 30_000 });
    const folder = path.join(baseDir, "Instagram", "demo.public");
    expect(readdirSync(folder).sort()).toEqual(["DP1-1.png", "DP1-2.png", "DP2-1.png", "DP2-2.png"]);

    // backed up signed out: the post shown only to signed-in visitors (DP5) is skipped and counted, the picked ones already there
    await main.getByRole("button", { name: "Profiles", exact: true }).click();
    await main.getByRole("button", { name: "Back up this profile" }).click();
    const confirm = main.getByRole("dialog", { name: "Back up @demo.public" });
    await expect(confirm).toContainText("Instagram doesn't say how many posts it holds.");
    await expect(confirm).toContainText("a 50-post profile takes a few minutes; a 1,000-post profile takes hours.");
    // tagged posts need a session: unticked, and they can't be ticked
    const tagged = confirm.getByRole("checkbox", { name: "Tagged", exact: true });
    await expect(tagged).toBeDisabled();
    await expect(tagged).not.toBeChecked();
    await expect(confirm).toContainText("Tagged needs a sign-in to Instagram.");
    await expect(confirm.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    // the posts alone, so the highlight picked below is still new
    await confirm.getByRole("checkbox", { name: "Highlights", exact: true }).uncheck();
    await confirm.getByRole("button", { name: "Start backup" }).click();
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    await expect(panel).toContainText("Done 6");
    await expect(panel).toContainText("New 8");
    await expect(panel).toContainText("1 shown only to signed-in visitors");
    expect(readdirSync(folder).sort()).toEqual(["DP1", "DP2", "DP3", "DP4", "DP6", "DP7"].flatMap((code) => [`${code}-1.png`, `${code}-2.png`]));

    await main.getByRole("tab", { name: "Highlights" }).click();
    await main.getByRole("button", { name: "Trips", exact: true }).click();
    const storiesOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Next (1)" }).click();
    const stories = await storiesOpened;
    const save = stories.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(save).toHaveText("Download all 2", { timeout: 15_000 });
    await save.click();
    await main.getByRole("button", { name: "All downloads" }).click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(6, { timeout: 30_000 });
    expect(readdirSync(path.join(folder, "Highlights")).sort()).toEqual(["h17900000000000005-1.png", "h17900000000000005-2.png"]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("settings: Instagram downloads can all go into one folder instead of one per account", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Settings" }).click();
    const perAccount = main.getByRole("checkbox", { name: "Put Instagram downloads in a folder per account" });
    await expect(perAccount).toBeChecked();
    await perAccount.uncheck();
    await main.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Save", exact: true }).click();
    await main.getByRole("button", { name: "Add URL" }).click();
    await main.getByPlaceholder("https://…").fill("https://www.instagram.com/p/DP3/");
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = await dialogOpened;
    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 2", { timeout: 15_000 });
    await download.click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(2, { timeout: 30_000 });
    expect(readdirSync(path.join(baseDir, "Instagram")).sort()).toEqual(["DP3-1.png", "DP3-2.png"]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
