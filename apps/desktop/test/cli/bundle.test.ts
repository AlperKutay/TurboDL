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

const hasPwsh = windows && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe("the Windows launcher", () => {
  const args = ["https://x.com/?a=1&b=2", "100%25", "a^b", "ç", "a b"];

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

  function expectEchoed(stdout: string, status: number | null, argv: string[] = args): void {
    expect(status).toBe(7);
    expect(JSON.parse(stdout.trim())).toEqual({ argv, node: "1" });
  }

  function runPowerShell(shell: string, exe: string, argv: string[]) {
    const quoted = argv.map((a) => `'${a}'`).join(" ");
    return spawnSync(shell, ["-NoProfile", "-Command", `& '${exe}' ${quoted}; exit $LASTEXITCODE`], { encoding: "utf8" });
  }

  function runBat(exe: string, separator: string, argLine: string) {
    const bat = path.join(workDir, "run.bat");
    // chcp first: cmd reads a batch file in the console's code page, which is not UTF-8 on most machines
    writeFileSync(bat, `@echo off\r\nchcp 65001 >nul\r\n"${exe}"${separator}${argLine}\r\nexit /b %ERRORLEVEL%\r\n`);
    return spawnSync("cmd", ["/d", "/c", bat], { encoding: "utf8" });
  }

  const batArgs = '"https://x.com/?a=1&b=2" "100%%25" "a^b" "ç" "a b"';

  it.runIf(windows)("passes links with & and % through Windows PowerShell untouched, with the exit code", () => {
    const { exe } = setup();
    const r = runPowerShell("powershell", exe, args);
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(hasPwsh)("passes links with & and % through PowerShell 7 untouched, with the exit code", () => {
    const { exe } = setup();
    const r = runPowerShell("pwsh", exe, args);
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(windows)("passes links with & and % through cmd untouched, with the exit code", () => {
    const { exe } = setup();
    const r = runBat(exe, " ", batArgs);
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(windows)("keeps arguments after a tab between the program and the first argument", () => {
    const { exe } = setup();
    const r = runBat(exe, "\t", batArgs);
    expectEchoed(r.stdout, r.status);
  });

  it.runIf(windows)("passes no arguments when there are none", () => {
    const { exe } = setup();
    const r = spawnSync(exe, [], { encoding: "utf8" });
    expectEchoed(r.stdout, r.status, []);
  });

  it.runIf(windows)("says TurboDL is not installed any more when the executable is gone", () => {
    const { exe } = setup();
    writeFileSync(path.join(workDir, "turbodl.cfg"), `${path.join(workDir, "missing.exe")}\n${path.join(workDir, "echo.cjs")}\n`, "utf8");
    const r = spawnSync(exe, ["get"], { encoding: "utf8" });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("TurboDL is not installed any more.");
  });

  it.runIf(windows)("treats a missing, empty or one-line turbodl.cfg like a missing executable", () => {
    const { exe } = setup();
    const cfg = path.join(workDir, "turbodl.cfg");
    for (const content of [null, "", `${process.execPath}\n`]) {
      rmSync(cfg, { force: true });
      if (content !== null) writeFileSync(cfg, content, "utf8");
      const r = spawnSync(exe, ["get"], { encoding: "utf8" });
      expect(r.status).toBe(5);
      expect(r.stderr).toContain("TurboDL is not installed any more.");
    }
  });
});
