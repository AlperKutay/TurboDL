import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** A script that writes the environment it was started with, as JSON, to the file named by TURBODL_ENV_OUT. */
export const DUMP_ENV = path.join(__dirname, "dump-env.cjs");

/**
 * What AppRun adds for a program started from an AppImage, under a mount that doesn't exist (PATH is left out: on
 * Windows it is spelled Path, and the launch tests run there too).
 */
export const APPRUN_ENV = {
  APPDIR: "/tmp/.mount_turbodltest",
  APPIMAGE: "/home/a/T.AppImage",
  ARGV0: "./T.AppImage",
  OWD: "/home/a",
  LD_LIBRARY_PATH: "/tmp/.mount_turbodltest/usr/lib",
  XDG_DATA_DIRS: "/tmp/.mount_turbodltest/usr/share/:/usr/share",
  ELECTRON_RUN_AS_NODE: "1",
};

/** The environment DUMP_ENV wrote to `file`; waits up to 10 s, since it runs detached. */
export async function dumpedEnv(file: string): Promise<Record<string, string>> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${file} was not written within 10 s`);
}
