import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "../test/fixtures/test-server";
import { launchApp, type LaunchedApp } from "./helpers";

const REPO = path.join(__dirname, "..", "..", "..");
const { findPython } = createRequire(__filename)(path.join(REPO, "scripts", "python-lookup.cjs")) as {
  findPython: () => { cmd: string; args: string[] } | null;
};
const python = findPython();

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a Python script that imports turbodl_client from the repo, against the app's temp profile. */
function runPython(userData: string, source: string): Promise<Ran> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-py-"));
  const script = path.join(dir, "script.py");
  writeFileSync(script, source, "utf8");
  return new Promise((resolve) => {
    execFile(
      python!.cmd,
      [...python!.args, script],
      {
        env: { ...process.env, PYTHONPATH: path.join(REPO, "clients", "python"), TURBODL_USER_DATA: userData, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
        timeout: 90_000,
      },
      (error, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function apiPort(userData: string): number | null {
  try {
    return (JSON.parse(readFileSync(path.join(userData, "api.json"), "utf8")) as { port: number | null }).port;
  } catch {
    return null;
  }
}

async function withApp(body: (ctx: LaunchedApp & { server: TestServer }) => Promise<void>): Promise<void> {
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, "") });
  try {
    await launched.app.firstWindow();
    await expect.poll(() => apiPort(launched.userData), { timeout: 15_000 }).not.toBeNull();
    await body({ ...launched, server });
  } finally {
    await launched.app.close().catch(() => undefined);
    await server.close();
    rmSync(launched.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

test.skip(process.platform !== "win32", "driven through the Windows app, as the other e2e specs");
test.skip(python === null, "Python 3.9+ not found");

test("gets a file and returns its path", async () => {
  await withApp(async ({ server, userData }) => {
    const data = randomBytes(200_000);
    server.setFile("/files/py.bin", { data, contentType: "application/octet-stream" });
    const r = await runPython(
      userData,
      `from turbodl_client import TurboDL\njob = TurboDL().get(${JSON.stringify(server.url("/files/py.bin"))})\nprint(job.files[0])\n`,
    );
    expect(r.code, r.stderr).toBe(0);
    const printed = r.stdout.split(/\r?\n/).filter(Boolean);
    expect(printed).toHaveLength(1);
    expect(existsSync(printed[0])).toBe(true);
    expect(readFileSync(printed[0]).equals(data)).toBe(true);
  });
});

test("raises SignInRequired for a signed-out profile, with the saved files on the job", async () => {
  await withApp(async ({ userData }) => {
    const r = await runPython(
      userData,
      [
        "from turbodl_client import TurboDL, SignInRequired",
        "try:",
        '    TurboDL().get("https://www.instagram.com/demo.public/")',
        "except SignInRequired as e:",
        '    print("SIGNIN", len(e.job.files))',
        "",
      ].join("\n"),
    );
    expect(r.code, r.stderr).toBe(0);
    const m = /SIGNIN (\d+)/.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});
