const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Windows and macOS ship ffmpeg-static's binary; Linux ships BtbN's build, which uses the system's glibc (see scripts/fetch-ffmpeg-linux.mjs)
const ffmpegDir = path.dirname(require.resolve("ffmpeg-static/package.json"));
const ffmpegStatic = { from: ffmpegDir, to: "ffmpeg", filter: ["ffmpeg", "ffmpeg.exe"] };

/**
 * With the Developer ID certificate (CSC_LINK, the release workflow's macOS jobs) the Mac app is signed with the
 * hardened runtime, and notarized by Apple when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are set too.
 * Without it (local builds), it is signed ad hoc as before.
 */
const developerId = Boolean(process.env.CSC_LINK);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.turbodl.app",
  productName: "TurboDL",
  directories: { output: "release", buildResources: "build" },
  files: ["out/**/*", "!out/cli/**", "package.json"],
  npmRebuild: false,
  extraResources: [
    { from: "resources/icons", to: "icons" },
    { from: "../extension/dist", to: "extension" },
    { from: "resources/native-host", to: "native-host" },
    { from: "out/cli", to: "cli" },
  ],
  // a Linux build fetches its ffmpeg first (a missing extraResources source is only a warning)
  beforePack: (context) => {
    if (context.electronPlatformName !== "linux") return;
    const res = spawnSync(process.execPath, [path.join(__dirname, "scripts", "fetch-ffmpeg-linux.mjs")], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("scripts/fetch-ffmpeg-linux.mjs failed: the Linux build needs build/ffmpeg-linux/ffmpeg");
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
    extraResources: [ffmpegStatic],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: "TurboDL-Setup-${version}.${ext}",
  },
  mac: {
    target: ["dmg"],
    icon: "build/icon.png",
    category: "public.app-category.utilities",
    extraResources: [ffmpegStatic],
    ...(developerId
      ? { hardenedRuntime: true, entitlements: "build/entitlements.mac.plist", entitlementsInherit: "build/entitlements.mac.plist" }
      : { identity: "-", hardenedRuntime: false }),
    gatekeeperAssess: false,
  },
  linux: {
    target: [
      { target: "deb", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
    icon: "build/icon.png",
    category: "Network",
    extraResources: [{ from: "build/ffmpeg-linux", to: "ffmpeg", filter: ["ffmpeg"] }],
    // not "turbodl": the deb links /usr/bin/<executable>, which would shadow or impersonate the CLI
    executableName: "turbodl-app",
    artifactName: "TurboDL-${version}-${arch}.${ext}",
  },
  deb: {
    packageName: "turbodl",
    maintainer: "AlperKutay <alperkozbek@gmail.com>",
    // electron-builder 26.15.3's defaults (app-builder-lib FpmTarget getDefaultDepends; this list replaces them), plus what
    // Electron loads at start and minimal systems lack: libgbm and ALSA. ALSA is "libasound2t64" from Ubuntu 24.04 on; a
    // plain "libasound2" there is a virtual package that apt fills with the OSS4 shim liboss4-salsa-asound2.
    depends: [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libgbm1",
      "libasound2t64 | libasound2",
    ],
  },
  dmg: {
    artifactName: "TurboDL-${version}-${arch}.${ext}",
  },
};
