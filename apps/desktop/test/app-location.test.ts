import path from "node:path";
import { describe, expect, it } from "vitest";
import { appLocation, launchEnv, linuxConfigHome } from "../src/main/app-location";

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

describe("launchEnv", () => {
  // what AppRun puts into the environment of a program started from the AppImage
  const appRun = {
    APPDIR: "/tmp/.mount_x",
    APPIMAGE: "/home/a/T.AppImage",
    ARGV0: "./T.AppImage",
    OWD: "/home/a",
    PATH: "/tmp/.mount_x:/tmp/.mount_x/usr/sbin:/usr/bin",
    LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib:/tmp/.mount_x/usr/lib/x86_64-linux-gnu",
    XDG_DATA_DIRS: "/tmp/.mount_x/usr/share/:/usr/share",
    GSETTINGS_SCHEMA_DIR: "/tmp/.mount_x/usr/share/glib-2.0/schemas:/usr/share/glib-2.0/schemas",
    ELECTRON_RUN_AS_NODE: "1",
    HOME: "/home/a",
  };

  it("leaves out an AppImage mount, which goes away when this process exits", () => {
    expect(launchEnv(appRun)).toEqual({ PATH: "/usr/bin", XDG_DATA_DIRS: "/usr/share", GSETTINGS_SCHEMA_DIR: "/usr/share/glib-2.0/schemas", HOME: "/home/a" });
  });

  it("does not change the environment it is given", () => {
    const env = { ...appRun };
    launchEnv(env);
    expect(env).toEqual(appRun);
  });

  it("keeps a folder that only shares the mount's prefix", () => {
    expect(launchEnv({ APPDIR: "/tmp/.mount_x", PATH: "/tmp/.mount_xy/bin:/tmp/.mount_x/usr/bin:/usr/bin" }).PATH).toBe("/tmp/.mount_xy/bin:/usr/bin");
  });

  it("only drops ELECTRON_RUN_AS_NODE without an AppImage (the .deb, Windows and macOS)", () => {
    const env = { PATH: "/tmp/.mount_x/usr/bin:/usr/bin", LD_LIBRARY_PATH: "/opt/lib", APPIMAGE: "/home/a/T.AppImage", OWD: "/home/a", HOME: "/home/a" };
    expect(launchEnv({ ...env, ELECTRON_RUN_AS_NODE: "1" })).toEqual(env);
    expect(launchEnv({ ...env, APPDIR: "" })).toEqual({ ...env, APPDIR: "" });
  });
});

describe("linuxConfigHome", () => {
  it("follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(linuxConfigHome({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/a")).toBe("/x/cfg");
    expect(linuxConfigHome({ XDG_CONFIG_HOME: "" }, "/home/a")).toBe(path.join("/home/a", ".config"));
    expect(linuxConfigHome({}, "/home/a")).toBe(path.join("/home/a", ".config"));
  });
});
