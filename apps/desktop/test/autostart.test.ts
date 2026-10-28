import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAutostart, autostartEntry, autostartFile, desktopExecArg } from "../src/main/autostart";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "turbodl-autostart-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("autostart", () => {
  it.each([
    ["/opt/TurboDL/turbodl-app", "/opt/TurboDL/turbodl-app"],
    ["--hidden", "--hidden"],
    ["/home/a/My Apps/TurboDL.AppImage", '"/home/a/My Apps/TurboDL.AppImage"'],
    ["/home/a/O'Neil/T.AppImage", `"/home/a/O'Neil/T.AppImage"`],
    ["/home/a/$HOME/T", '"/home/a/\\\\$HOME/T"'],
    ['/home/a/say "hi"/T', '"/home/a/say \\\\"hi\\\\"/T"'],
    ["/home/a/100%/T", '"/home/a/100%%/T"'],
    ["/home/a/back\\slash/T", '"/home/a/back\\\\\\\\slash/T"'],
  ])("quotes Exec arguments as the Desktop Entry spec asks: %s", (arg, text) => {
    expect(desktopExecArg(arg)).toBe(text);
  });

  it("writes an entry that starts TurboDL hidden", () => {
    expect(autostartEntry({ file: "/home/a/My Apps/TurboDL.AppImage", args: ["--hidden"] })).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=TurboDL",
        "Comment=Starts TurboDL in the background",
        'Exec="/home/a/My Apps/TurboDL.AppImage" --hidden',
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
  });

  it("writes, rewrites and removes the entry", () => {
    const file = path.join(dir, "config", "autostart", "turbodl.desktop");
    applyAutostart({ enabled: true, file, launch: { file: "/opt/a", args: ["--hidden"] } });
    expect(readFileSync(file, "utf8")).toBe(autostartEntry({ file: "/opt/a", args: ["--hidden"] }));
    applyAutostart({ enabled: true, file, launch: { file: "/opt/b", args: ["--hidden"] } });
    expect(readFileSync(file, "utf8")).toContain("Exec=/opt/b --hidden\n");
    applyAutostart({ enabled: false, file, launch: { file: "/opt/b", args: ["--hidden"] } });
    expect(existsSync(file)).toBe(false);
    expect(() => applyAutostart({ enabled: false, file, launch: { file: "/opt/b", args: ["--hidden"] } })).not.toThrow();
  });

  it("lives in XDG_CONFIG_HOME/autostart", () => {
    expect(autostartFile({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe(path.join("/x", "autostart", "turbodl.desktop"));
    expect(autostartFile({}, "/h")).toBe(path.join("/h", ".config", "autostart", "turbodl.desktop"));
  });
});
