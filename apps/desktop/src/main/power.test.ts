import { describe, expect, it } from "vitest";
import { powerCommand } from "./power";

describe("powerCommand", () => {
  it("knows Windows commands", () => {
    expect(powerCommand("shutdown", "win32")).toEqual({ command: "shutdown", args: ["/s", "/t", "0"] });
    expect(powerCommand("sleep", "win32")).toEqual({ command: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] });
  });

  it("knows macOS commands", () => {
    expect(powerCommand("shutdown", "darwin")).toEqual({ command: "osascript", args: ["-e", 'tell application "System Events" to shut down'] });
    expect(powerCommand("sleep", "darwin")).toEqual({ command: "pmset", args: ["sleepnow"] });
  });
});
