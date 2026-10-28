import path from "node:path";
import { describe, expect, it } from "vitest";
import { appLocation, linuxConfigHome } from "../src/main/app-location";

describe("appLocation", () => {
  it("uses the AppImage file, not its mount point", () => {
    expect(
      appLocation({
        platform: "linux",
        execPath: "/tmp/.mount_TurboDabc/turbodl-app",
        env: { APPIMAGE: "/home/a/Apps/TurboDL-0.8.0-x86_64.AppImage", APPDIR: "/tmp/.mount_TurboDabc" }
      })
    ).toEqual({ file: "/home/a/Apps/TurboDL-0.8.0-x86_64.AppImage", appImage: true });
  });

  it("uses the executable of the .deb, also with an APPIMAGE inherited from another program", () => {
    const execPath = "/opt/TurboDL/turbodl-app";
    const expected = { file: execPath, appImage: false };
    expect(appLocation({ platform: "linux", execPath, env: {} })).toEqual(expected);
    expect(appLocation({ platform: "linux", execPath, env: { APPIMAGE: "/home/a/T.AppImage", APPDIR: "/tmp/.mount_old" } })).toEqual(expected);
    expect(appLocation({ platform: "linux", execPath, env: { APPIMAGE: "/home/a/T.AppImage" } })).toEqual(expected);
  });

  it("ignores APPIMAGE outside Linux", () => {
    const env = { APPIMAGE: "/home/a/T.AppImage", APPDIR: "/tmp/.mount_x" };
    for (const platform of ["win32", "darwin"] as const) {
      expect(appLocation({ platform, execPath: "/tmp/.mount_x/turbodl-app", env }).appImage).toBe(false);
    }
  });
});

describe("linuxConfigHome", () => {
  it("follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(linuxConfigHome({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/a")).toBe("/x/cfg");
    expect(linuxConfigHome({ XDG_CONFIG_HOME: "" }, "/home/a")).toBe(path.join("/home/a", ".config"));
    expect(linuxConfigHome({}, "/home/a")).toBe(path.join("/home/a", ".config"));
  });
});
