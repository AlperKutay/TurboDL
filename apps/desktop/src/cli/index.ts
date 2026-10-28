import os from "node:os";
import { spawnDetached } from "./discover";
import { EXIT } from "./exit";
import { APPIMAGE_NODE_FLAG } from "../main/app-location";
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

// A reader that closes early (`turbodl get ... | head -1`) is not an error: stop writing quietly,
// keeping the exit code the command would have had (a closed pipe is the reader's choice, not a failure).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});

run({
  // an AppImage launcher puts the flag AppRun needs right after the script
  argv: process.argv[2] === APPIMAGE_NODE_FLAG ? process.argv.slice(3) : process.argv.slice(2),
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
