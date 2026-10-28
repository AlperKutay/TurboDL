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

/** XDG_CONFIG_HOME when non-empty, else ~/.config. */
export function linuxConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}
