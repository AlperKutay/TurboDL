import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundles the `turbodl` command into one CommonJS file and, on Windows, compiles its console launcher.
// Usage: node scripts/build-cli.mjs [--outdir <dir>]   (default: out/cli)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const flag = process.argv.indexOf("--outdir");
const outdir = flag >= 0 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : path.join(root, "out", "cli");
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/cli/index.ts")],
  outfile: path.join(outdir, "turbodl.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  charset: "utf8",
  logLevel: "info",
  define: { __TURBODL_VERSION__: JSON.stringify(pkg.version) },
});

if (process.platform === "win32") {
  const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!existsSync(csc)) {
    console.error("csc.exe not found: the Windows command-line launcher can't be built.");
    process.exit(1);
  }
  const exe = path.join(outdir, "turbodl.exe");
  const compiled = spawnSync(csc, ["/nologo", "/target:exe", "/optimize+", "/platform:anycpu", `/out:${exe}`, path.join(root, "resources", "cli", "launcher.cs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (compiled.status !== 0) {
    console.error(`${compiled.stdout}${compiled.stderr}`);
    process.exit(1);
  }
}
console.log(`CLI ready: ${outdir}`);
