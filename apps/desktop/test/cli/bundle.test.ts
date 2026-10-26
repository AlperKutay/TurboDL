import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const desktopRoot = path.resolve(__dirname, "..", "..");
const version = (JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")) as { version: string }).version;
const windows = process.platform === "win32";

let outDir = "";
let workDir = "";

beforeAll(() => {
  outDir = mkdtempSync(path.join(os.tmpdir(), "turbodl-bundle-"));
  workDir = mkdtempSync(path.join(os.tmpdir(), "turbodl-launcher-"));
  const built = spawnSync(process.execPath, ["scripts/build-cli.mjs", "--outdir", outDir], { cwd: desktopRoot, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`build-cli failed (${built.status}): ${built.stdout}${built.stderr}`);
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("the bundled turbodl command", () => {
  it("runs on plain Node and prints its version", () => {
    const r = spawnSync(process.execPath, [path.join(outDir, "turbodl.cjs"), "--version"], { encoding: "utf8" });
    expect(r.stdout).toBe(`turbodl ${version}\n`);
    expect(r.status).toBe(0);
  });

  it("answers wrong usage with code 2", () => {
    const r = spawnSync(process.execPath, [path.join(outDir, "turbodl.cjs"), "get"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe("the Windows launcher", () => {
  const args = ["https://x.com/?a=1&b=2", "100%25", "a^b", "ç"];

  function setup(): { exe: string } {
    const exe = path.join(workDir, "turbodl.exe");
    const echo = path.join(workDir, "echo.cjs");
    writeFileSync(
      echo,
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));\nprocess.exit(7);\n',
    );
    // the launcher reads turbodl.cfg next to itself, so it runs from a private copy
    writeFileSync(path.join(workDir, "turbodl.cfg"), `${process.execPath}\n${echo}\n`, "utf8");
    writeFileSync(exe, readFileSync(path.join(outDir, "turbodl.exe")));
    return { exe };
  }

  function expectEchoed(stdout: string, status: number | null): void {
    expect(status).toBe(7);
    expect(JSON.parse(stdout.trim())).toEqual({ argv: args, node: "1" });
  }

  it.runIf(windows)("passes links with & and % through PowerShell untouched, with the exit code", () => {
    const { exe } = setup();
    const quoted = args.map((a) => `'${a}'`).join(" ");
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `& '${exe}' ${quoted}; exit $LASTEXITCODE`], { encoding: "utf8" });
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(windows)("passes links with & and % through cmd untouched, with the exit code", () => {
    const { exe } = setup();
    const bat = path.join(workDir, "run.bat");
    writeFileSync(bat, `@echo off\r\n"${exe}" "https://x.com/?a=1&b=2" "100%%25" "a^b" "ç"\r\nexit /b %ERRORLEVEL%\r\n`);
    const r = spawnSync("cmd", ["/d", "/c", bat], { encoding: "utf8" });
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(windows)("says TurboDL is not installed any more when the executable is gone", () => {
    const { exe } = setup();
    writeFileSync(path.join(workDir, "turbodl.cfg"), `${path.join(workDir, "missing.exe")}\n${path.join(workDir, "echo.cjs")}\n`, "utf8");
    const r = spawnSync(exe, ["get"], { encoding: "utf8" });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("TurboDL is not installed any more.");
  });
});
