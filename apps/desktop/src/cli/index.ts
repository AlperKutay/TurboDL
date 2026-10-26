import os from "node:os";
import { spawnDetached } from "./discover";
import { EXIT } from "./exit";
import { run } from "./main";

/** The app's version, set by the build. */
declare const __TURBODL_VERSION__: string;

// The bundle's entry: the real process around run().
const interruptHandlers = new Set<() => void>();
process.on("SIGINT", () => {
  // nothing to cancel (still starting the app, or a command that only asks): stop at once
  if (interruptHandlers.size === 0) process.exit(EXIT.interrupted);
  for (const handler of [...interruptHandlers]) handler();
});

run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
  tty: Boolean(process.stderr.isTTY),
  version: __TURBODL_VERSION__,
  onInterrupt: (handler) => {
    interruptHandlers.add(handler);
    return () => void interruptHandlers.delete(handler);
  },
  spawn: (launch) => spawnDetached(launch, process.env),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`turbodl: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT.failed;
  },
);
