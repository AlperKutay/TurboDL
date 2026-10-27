import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "../test/fixtures/test-server";
import { launchApp, type LaunchedApp } from "./helpers";

const electronExe = createRequire(__filename)("electron") as string;
const CLI = path.join(__dirname, "..", "out", "cli", "turbodl.cjs");

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `turbodl <args>` from the built bundle against the app's temp profile. */
function turbodl(userData: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      electronExe,
      [CLI, ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TURBODL_USER_DATA: userData }, windowsHide: true, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

/** Stops whatever listens on the port (the app the command started). */
function killListener(port: number): void {
  const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
  const pid = out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((cols) => cols[1] === `127.0.0.1:${port}` && cols[3] === "LISTENING")?.[4];
  if (pid) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

function apiPort(userData: string): number | null {
  try {
    return (JSON.parse(readFileSync(path.join(userData, "api.json"), "utf8")) as { port: number | null }).port;
  } catch {
    return null;
  }
}

async function withApp(
  env: Record<string, string>,
  body: (ctx: LaunchedApp & { server: TestServer }) => Promise<void>,
  onFinally?: (ctx: LaunchedApp) => void,
): Promise<void> {
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, ""), ...env });
  try {
    await appReady(launched);
    await body({ ...launched, server });
  } finally {
    try {
      onFinally?.(launched);
    } catch {
      // cleanup below must still run
    }
    await launched.app.close().catch(() => undefined);
    await server.close();
    rmSync(launched.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

/** The command finds the app through api.json, which is written once the app is up. */
async function appReady(l: LaunchedApp): Promise<void> {
  await l.app.firstWindow();
  await expect.poll(() => apiPort(l.userData), { timeout: 15_000 }).not.toBeNull();
}

test.skip(process.platform !== "win32", "the command is driven through the Windows app, as the other e2e specs");

test("gets a file and prints its path", async () => {
  await withApp({}, async ({ server, userData }) => {
    const data = randomBytes(200_000);
    server.setFile("/files/cli.bin", { data, contentType: "application/octet-stream" });
    const r = await turbodl(userData, ["get", server.url("/files/cli.bin")]);
    expect(r.code, r.stderr).toBe(0);
    const printed = lines(r.stdout);
    expect(printed).toHaveLength(1);
    expect(existsSync(printed[0])).toBe(true);
    expect(readFileSync(printed[0]).equals(data)).toBe(true);
  });
});

test("passes a link with &, %, ^, spaces and non-ASCII characters through intact", async () => {
  await withApp({}, async ({ server, userData }) => {
    const data = randomBytes(30_000);
    server.setFile("/files/a%20b%26c%2541.bin", { data, contentType: "application/octet-stream" });
    const link = server.url("/files/a%20b%26c%2541.bin") + "?q=a&b=%41^é";
    const r = await turbodl(userData, ["get", link]);
    expect(r.code, r.stderr).toBe(0);
    const printed = lines(r.stdout);
    expect(printed).toHaveLength(1);
    expect(readFileSync(printed[0]).equals(data)).toBe(true);
    expect(server.requests.some((q) => q.url.includes("b=%41") && q.url.includes("%C3%A9"))).toBe(true);
  });
});

test("prints JSON lines with --json", async () => {
  await withApp({}, async ({ server, userData }) => {
    server.setFile("/files/j.bin", { data: randomBytes(50_000), contentType: "application/octet-stream" });
    const r = await turbodl(userData, ["get", "--json", server.url("/files/j.bin")]);
    expect(r.code, r.stderr).toBe(0);
    const events = lines(r.stdout).map((l) => JSON.parse(l) as { type: string; jobId: string; path?: string; job?: { state: string; files: string[] } });
    const end = events.find((e) => e.type === "end");
    expect(end?.job?.state).toBe("done");
    expect(end?.job?.files).toHaveLength(1);
    expect(existsSync(end!.job!.files[0])).toBe(true);
    expect(events.every((e) => typeof e.jobId === "string")).toBe(true);
  });
});

test("backs up a demo profile and its highlights", async () => {
  await withApp({}, async ({ userData, baseDir }) => {
    const r = await turbodl(userData, ["get", "https://www.instagram.com/demo.person/", "--highlights"]);
    expect(r.code, r.stderr).toBe(0);
    const root = path.join(baseDir, "Instagram", "demo.person");
    expect(readdirSync(root).filter((f) => f.endsWith(".png"))).toHaveLength(6);
    expect(readdirSync(path.join(root, "Highlights"))).toHaveLength(4);
    for (const printed of lines(r.stdout)) expect(existsSync(printed)).toBe(true);
    expect(lines(r.stdout).length).toBeGreaterThanOrEqual(10);
  });
});

/** demo.public's posts other than DP5, which Instagram shows only to signed-in visitors: two photos each. */
const READABLE = ["DP1", "DP2", "DP3", "DP4", "DP6", "DP7"].flatMap((code) => [`${code}-1.png`, `${code}-2.png`]);
const SIGN_IN_ONLY_WARNING = "warning: 1 post is shown only to signed-in visitors; sign in to save them.";

test("backs up a profile seen signed out, exiting 3 only for its post shown to signed-in visitors", async () => {
  await withApp({}, async ({ userData, baseDir }) => {
    const r = await turbodl(userData, ["get", "https://www.instagram.com/demo.public/"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr).toContain(SIGN_IN_ONLY_WARNING);
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.public")).sort()).toEqual(READABLE);
  });
});

test("backs up a profile and its highlights without signing in", async () => {
  await withApp({ TURBODL_INSTAGRAM_DEMO_SIGNED_OUT: "1" }, async ({ userData, baseDir }) => {
    const status = await turbodl(userData, ["instagram", "status"]);
    expect(status.stdout).toContain("signedIn: false");
    const r = await turbodl(userData, ["get", "https://www.instagram.com/demo.public/", "--highlights"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr).toContain(SIGN_IN_ONLY_WARNING);
    const root = path.join(baseDir, "Instagram", "demo.public");
    expect(readdirSync(root).filter((f) => f.endsWith(".png")).sort()).toEqual(READABLE);
    // the second highlight comes from the tray's next page
    expect(readdirSync(path.join(root, "Highlights")).sort()).toEqual(["h17900000000000005-1.png", "h17900000000000005-2.png", "h17900000000000006-1.png", "h17900000000000006-2.png"]);
    for (const printed of lines(r.stdout)) expect(existsSync(printed)).toBe(true);
    expect(lines(r.stdout)).toHaveLength(16);
  });
});

test("ends a followed job with 6 when another command cancels it", async () => {
  await withApp({}, async ({ server, userData }) => {
    server.setFile("/files/slow.bin", { data: randomBytes(4 * 1024 * 1024), contentType: "application/octet-stream", throttle: 20_000 });
    const added = await turbodl(userData, ["add", server.url("/files/slow.bin")]);
    expect(added.code, added.stderr).toBe(0);
    const id = lines(added.stdout)[0];
    expect(id).toBeTruthy();
    const waiting = turbodl(userData, ["wait", id]);
    await expect.poll(() => server.requests.filter((q) => q.path === "/files/slow.bin").length, { timeout: 15_000 }).toBeGreaterThan(0);
    const cancelled = await turbodl(userData, ["cancel", id]);
    expect(cancelled.code, cancelled.stderr).toBe(0);
    const r = await waiting;
    expect(r.code, r.stderr).toBe(6);
    expect(r.stderr).toContain("cancelled");
  });
});

test("starts TurboDL when it is closed", async () => {
  let startedPort: number | null = null;
  await withApp(
    {},
    async ({ app, server, userData }) => {
      server.setFile("/files/boot.bin", { data: randomBytes(20_000), contentType: "application/octet-stream" });
      await app.close();
      const r = await turbodl(userData, ["get", server.url("/files/boot.bin")]);
      startedPort = apiPort(userData);
      expect(r.code, r.stderr).toBe(0);
      expect(existsSync(lines(r.stdout)[0])).toBe(true);
      expect(startedPort).not.toBeNull();
    },
    (l) => {
      // the command started this app on its own; stop it before the profile goes
      const port = startedPort ?? apiPort(l.userData);
      if (port !== null) killListener(port);
    },
  );
});

test("shows the Command line section in Settings", async () => {
  await withApp({}, async ({ app }) => {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Settings" }).click();
    const dialog = main.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "Command line" })).toBeVisible();
    await expect(dialog.getByText("Available in the installed app.")).toBeVisible();
  });
});
