const path = require("node:path");

const ffmpegDir = path.dirname(require.resolve("ffmpeg-static/package.json"));

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.turbodl.app",
  productName: "TurboDL",
  directories: { output: "release", buildResources: "build" },
  files: ["out/**/*", "package.json"],
  npmRebuild: false,
  extraResources: [
    { from: "resources/icons", to: "icons" },
    { from: "../extension/dist", to: "extension" },
    { from: ffmpegDir, to: "ffmpeg", filter: ["ffmpeg", "ffmpeg.exe"] },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
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
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    artifactName: "TurboDL-${version}-${arch}.${ext}",
  },
};
