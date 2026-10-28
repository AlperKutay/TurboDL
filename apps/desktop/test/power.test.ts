import { describe, expect, it } from "vitest";
import { powerCommand } from "../src/main/power";

describe("power", () => {
  it("uses systemctl on Linux", () => {
    expect(powerCommand("shutdown", "linux")).toEqual({ command: "systemctl", args: ["poweroff"] });
    expect(powerCommand("sleep", "linux")).toEqual({ command: "systemctl", args: ["suspend"] });
  });
});
