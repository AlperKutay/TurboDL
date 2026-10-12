# TurboDL

A download manager for personal use, inspired by IDM. It has two parts: a desktop app for **Windows** and **macOS**, and a **Chrome extension**.

## Features

- **Fast downloads:** Splits a file into 8 parts and downloads them at once. A connection that finishes takes over the rest of the slowest part.
- **Resume:** If the connection drops, the app closes or the computer restarts, an unfinished download continues where it left off.
- **Chrome integration:** When you click a file in Chrome, the download moves to TurboDL. If the app is closed, Chrome downloads it as usual, so no download is lost.
- **Context menu:** "Download with TurboDL" on links, videos and audio.
- **Video downloads:** Pages with a video show a "⬇ TurboDL" button.
  - Plain video files (mp4, webm…) are downloaded by TurboDL's own engine.
  - HLS/DASH streams and sites like YouTube are downloaded with `yt-dlp`; you can choose the quality.
- **Queue and scheduler:** Starts the downloads you marked "Download later" at the time you set. When they finish it can shut down or sleep the computer.
- **Automatic sorting:** Files go into the Video, Music, Programs, Archives, Documents, Images and Other folders under `Downloads/TurboDL/`, by type.

## Installation

### Windows

1. Run `apps/desktop/release/TurboDL-Setup-0.1.0.exe`.
2. If Windows warns about an "Unknown publisher", click **More info → Run anyway**. The app is not signed, so this warning is expected.

### macOS

1. Build the project on a Mac (see "Development" below). This creates `apps/desktop/release/TurboDL-0.1.0-<arch>.dmg`.
2. Open the DMG and drag TurboDL into **Applications**.
3. The first time, **right-click TurboDL → Open**.
   - If it still does not open: **System Settings → Privacy & Security → Open Anyway**.
   - If that does not help either, run this in Terminal:
     ```bash
     xattr -cr /Applications/TurboDL.app
     ```

### Chrome extension

1. In TurboDL, click **Settings → Install the Chrome extension…**. The extension is copied to `Documents/TurboDL Extension` and the folder opens.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and choose that folder.

The same steps work for Edge (`edge://extensions`) and Brave (`brave://extensions`).

## Usage

- **Files:** Click a file in Chrome. TurboDL opens a window where you confirm the file name and folder. You can turn this window off in Settings.
- **Videos:** Hover over the video, click the **⬇ TurboDL** button in its top right corner and choose the quality.
- **Extension icon:** Lists the media found on the current page. You can turn download capture on and off here.
- **Scheduler:** The **Scheduler** button in the toolbar. If you choose **Download later** in the new download window, the download waits for the scheduler.
- **Refresh link:** Right-click a download whose link expired, choose **Refresh link…** and paste the new address. If the file is the same, the download continues where it left off.

## Development

Requirements:
- Node.js 22 or newer (24 recommended), pnpm 11, git
- On macOS also the Xcode command line tools: `xcode-select --install`

```bash
pnpm install          # dependencies
pnpm dev              # run in development mode
pnpm test             # unit and integration tests
pnpm typecheck        # type check
pnpm --filter @turbodl/extension exec playwright install chromium   # needed once
pnpm e2e              # end-to-end tests (real Chromium + real app)
pnpm dist             # installer → apps/desktop/release/
pnpm --filter @turbodl/desktop smoke:packaged   # quick check of the packaged app
```

The installer is built for the system it is built on: `.exe` on Windows, `.dmg` on a Mac.

## Troubleshooting

| Problem | Fix |
|---|---|
| The app says "Browser bridge closed" | Port 47123 is used by another program. Choose another port in Settings and enter the same number under extension icon → **Advanced**. |
| Chrome does not send downloads to TurboDL | Does the extension icon say "Connected"? Is "Send downloads to TurboDL" checked? Is the file extension in the list in Settings? |
| The extension icon shows a red "!" | The app is closed or could not open the download link. Chrome then downloads the file itself. |
| A YouTube download fails | yt-dlp updates itself once a week. To update now, quit TurboDL and delete `tools/yt-dlp`; the newest version is downloaded with the next video. |

Where the app keeps its data:
- Windows: `%APPDATA%\TurboDL`
- macOS: `~/Library/Application Support/TurboDL`

This folder holds the settings, the download list and the video tools. The download list also contains cookies from sites that need a login.

## Architecture

```
packages/shared   Code shared by the extension and the app (protocol types, categories, file names, capture decision)
apps/desktop      Electron app
  src/main        Download engine (engine/), queue (manager), scheduler, yt-dlp (media/), bridge server
  src/renderer    React UI
apps/extension    Chrome MV3 extension (bundled with esbuild)
```

- The extension and the app talk over `127.0.0.1:47123`.
- The app only accepts requests from the TurboDL extension's ID (`Origin` header).
