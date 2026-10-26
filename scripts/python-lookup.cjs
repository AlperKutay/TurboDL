// Finds a Python 3.9+ interpreter. Shared by scripts/test-python.mjs and the Python client's e2e spec.
const { spawnSync } = require("node:child_process");

const CANDIDATES = [
  { cmd: "python3", args: [] },
  { cmd: "python", args: [] },
  { cmd: "py", args: ["-3"] },
];

/** True for "Python 3.9" or newer. */
function isSupported(text) {
  const m = /Python (\d+)\.(\d+)/.exec(text);
  return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9));
}

/**
 * The first of python3, python, py -3 whose `--version` runs and reports 3.9 or newer, as { cmd, args }, or null.
 * Windows' python3.exe Store alias exits 9009 without running Python, so it is skipped by running it.
 */
function findPython() {
  for (const c of CANDIDATES) {
    const r = spawnSync(c.cmd, [...c.args, "--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (r.error || r.status !== 0) continue;
    if (isSupported(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}

module.exports = { findPython, isSupported };
