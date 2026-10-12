import { spawn } from "node:child_process";

export type PowerAction = "sleep" | "shutdown";

export function powerCommand(action: PowerAction, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") {
    return action === "shutdown"
      ? { command: "shutdown", args: ["/s", "/t", "0"] }
      : { command: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] };
  }
  if (platform === "darwin") {
    return action === "shutdown"
      ? { command: "osascript", args: ["-e", 'tell application "System Events" to shut down'] }
      : { command: "pmset", args: ["sleepnow"] };
  }
  return action === "shutdown" ? { command: "systemctl", args: ["poweroff"] } : { command: "systemctl", args: ["suspend"] };
}

export function runPowerAction(action: PowerAction): void {
  const { command, args } = powerCommand(action);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}
