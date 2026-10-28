import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApiLaunch } from "@turbodl/shared";
import { linuxConfigHome } from "./app-location";

/** <linuxConfigHome>/autostart/turbodl.desktop */
export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(linuxConfigHome(env, home), "autostart", "turbodl.desktop");
}

/** One Exec argument, per the Desktop Entry spec. */
export function desktopExecArg(arg: string): string {
  if (/^[A-Za-z0-9_\-./+,:@=]+$/.test(arg)) return arg;
  // the Exec quoting escapes \ " ` $ with a backslash, and the string value's own escaping doubles every backslash
  const quoted = arg.replace(/[\\"`$]/g, "\\$&").replace(/\\/g, "\\\\").replace(/%/g, "%%");
  return `"${quoted}"`;
}

/** The entry that starts TurboDL at login; launch is api.json's (its args already end in --hidden). */
export function autostartEntry(launch: ApiLaunch): string {
  return (
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=TurboDL",
      "Comment=Starts TurboDL in the background",
      `Exec=${[launch.file, ...launch.args].map(desktopExecArg).join(" ")}`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
    ].join("\n") + "\n"
  );
}

/** Writes the entry when enabled (creating the folder), removes it otherwise; idempotent. */
export function applyAutostart(o: { enabled: boolean; file: string; launch: ApiLaunch }): void {
  if (o.enabled) {
    mkdirSync(path.dirname(o.file), { recursive: true });
    writeFileSync(o.file, autostartEntry(o.launch));
  } else {
    rmSync(o.file, { force: true });
  }
}
