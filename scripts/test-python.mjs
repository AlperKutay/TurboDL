// Runs the Python client's unittest suite with whichever Python 3.9+ is on this machine.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { findPython } = createRequire(import.meta.url)("./python-lookup.cjs");

const python = findPython();
if (!python) {
  console.log("Python 3.9+ not found: skipping the Python client tests.");
  process.exit(0);
}

const r = spawnSync(
  python.cmd,
  [...python.args, "-m", "unittest", "discover", "-s", "clients/python/tests", "-t", "clients/python"],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
process.exit(r.status ?? 1);
