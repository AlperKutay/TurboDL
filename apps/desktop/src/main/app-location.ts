import path from "node:path";

/**
 * Not for Electron's own use: AppRun skips adding its own --no-sandbox when this is among the arguments, and in front of
 * a script Node mode would refuse it.
 */
export const APPIMAGE_NODE_FLAG = "--no-sandbox";

export interface AppLocation {
  file: string;
  appImage: boolean;
}

/**
 * Where TurboDL can be started from: on Linux, with APPIMAGE and APPDIR non-empty and execPath under APPDIR + "/", the
 * AppImage file (its /tmp/.mount_* folder changes on every start); otherwise execPath.
 * Keep native-host/host.cjs's launchSpec in sync (it cannot import this module).
 */
export function appLocation(o: { platform: NodeJS.Platform; execPath: string; env: NodeJS.ProcessEnv }): AppLocation {
  const { APPIMAGE, APPDIR } = o.env;
  if (o.platform === "linux" && APPIMAGE && APPDIR && o.execPath.startsWith(`${APPDIR}/`)) return { file: APPIMAGE, appImage: true };
  return { file: o.execPath, appImage: false };
}

/** The lists AppRun puts the AppImage's mount into, and the variables it adds itself. */
const APPRUN_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];
const APPRUN_MARKERS = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/**
 * The environment for a TurboDL this process starts: a copy without ELECTRON_RUN_AS_NODE. With APPDIR non-empty (this
 * process runs from an AppImage), also without AppRun's markers and without every `:`-separated entry of APPRUN_LISTS that
 * is APPDIR or under it (a list left empty is removed): the mount goes away when this process exits, and another user could
 * then create a folder there.
 * Keep native-host/host.cjs's launchEnv in sync (it cannot import this module).
 */
export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  const dir = env.APPDIR;
  if (!dir) return out;
  for (const name of APPRUN_LISTS) {
    const value = out[name];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((entry) => entry !== dir && !entry.startsWith(`${dir}/`))
      .join(":");
    if (kept) out[name] = kept;
    else delete out[name];
  }
  for (const name of APPRUN_MARKERS) delete out[name];
  return out;
}

/** XDG_CONFIG_HOME when non-empty, else ~/.config. */
export function linuxConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}
