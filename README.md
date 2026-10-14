# TurboDL

A download manager for personal use, inspired by IDM. It has two parts:
- a desktop app for **Windows** and **macOS**,
- a browser extension for **Chrome, Edge and Brave**.

## Features

- **Fast downloads:** Splits a file into 8 parts and downloads them at once. A connection that finishes takes over the rest of the slowest part.
- **Resume:** If the connection drops, the app closes or the computer restarts, an unfinished download continues where it left off.
- **Browser integration:** When you click a file in the browser, the download moves to TurboDL.
  - If TurboDL is closed, the extension starts it.
  - If it cannot, the browser downloads the file as usual, so no download is lost.
- **Context menu:** "Download with TurboDL" on links, videos and audio.
- **Video downloads:** Pages with a video show a "⬇ TurboDL" button.
  - Plain video files (mp4, webm…) are downloaded by TurboDL's own engine.
  - HLS/DASH streams and sites like YouTube are downloaded with `yt-dlp`; you can choose the quality.
- **Age-restricted and members-only videos:** If a video needs a login, your browser session is used.
  - This only happens when the video really asks for a login, for example YouTube's age check or members-only videos.
- **Clipboard:** When you copy a download link with a listed extension, TurboDL opens the confirmation window. In the main window, **Ctrl+V** (**⌘V** on Mac) adds the copied link directly.
- **Queue and scheduler:** Starts the downloads you marked "Download later" at the time you set. When they finish it can shut down or sleep the computer.
- **Automatic sorting:** Files go into these folders under `Downloads/TurboDL/`, by type: Video, Music, Programs, Archives, Documents, Images and Other.

## Installation

### Windows

1. Run `apps/desktop/release/TurboDL-Setup-0.2.0.exe`.
2. If Windows warns about an "Unknown publisher", click **More info → Run anyway**. The app is not signed, so this warning is expected.

### macOS

1. Build the project on a Mac (see "Development" below). This creates `apps/desktop/release/TurboDL-0.2.0-<arch>.dmg`.
2. Open the DMG and drag TurboDL into **Applications**.
3. The first time, **right-click TurboDL → Open**.
   - If it still does not open: **System Settings → Privacy & Security → Open Anyway**.
   - If that does not help either, run this in Terminal:
     ```bash
     xattr -cr /Applications/TurboDL.app
     ```

### Browser extension (Chrome, Edge, Brave)

1. In TurboDL, click **Settings → Install the browser extension…**. The extension is copied to `Documents/TurboDL Extension` and the folder opens.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode**. It is in the top right in Chrome and Brave, and in the left menu in Edge.
4. Click **Load unpacked** and choose that folder.

Open TurboDL at least once. From then on the extension starts TurboDL by itself when it is closed.

### Updating from 0.1

1. Run the new installer. It installs over the old version and keeps your download list and settings.
2. Open TurboDL once.
3. Copy the extension again with **Settings → Install the browser extension…**.
4. On the browser's extensions page, press **reload (⟳)** on the TurboDL card.

## Usage

- **Files:** Click a file in the browser. TurboDL opens a window where you confirm the file name and folder. You can turn this window off in Settings.
- **Videos:** Hover over the video, click the **⬇ TurboDL** button in its top right corner and choose the quality.
- **Age-restricted videos:** Open the video in your browser while signed in and use the **⬇ TurboDL** button. The window then notes that your browser session is used.
- **Copy to download:** Copy a download link and the confirmation window opens. Turn this off with Settings → "Capture copied download links".
- **Extension icon:** Lists the media found on the current page and turns download capture on and off. If TurboDL is closed, a **Start TurboDL** button appears.
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
pnpm e2e              # end-to-end tests (real Chromium/Edge + real app)
pnpm dist             # installer → apps/desktop/release/
pnpm --filter @turbodl/desktop smoke:packaged   # quick check of the packaged app
```

Notes:
- The installer is built for the system it is built on: `.exe` on Windows, `.dmg` on a Mac.
- The "start from the browser" end-to-end tests run only on Windows. They write a temporary registry key and restore it afterwards.
- The clipboard test uses the system clipboard and puts the old content back afterwards.

## Troubleshooting

| Problem | Fix |
|---|---|
| The app says "Browser bridge closed" | Port 47123 is used by another program. Choose another port in Settings and enter the same number under extension icon → **Advanced**. |
| The browser does not send downloads to TurboDL | Does the extension icon say "Connected"? Is "Send downloads to TurboDL" checked? Is the file extension in the list in Settings? |
| The extension cannot start TurboDL ("Could not start it") | Open TurboDL once by hand; the browser link is registered on every start. On a Mac, if you moved the app after opening it, open it once more. |
| An age-restricted video does not download | Open the video in your browser while signed in and use the **⬇ TurboDL** button. Complete the site's age check if needed. Links pasted into the app by hand carry no browser session. |
| The extension icon shows a red "!" | The app could not be started or could not open the download link. The browser then downloads the file itself. |
| A YouTube download fails | yt-dlp updates itself once a week. To update now, quit TurboDL and delete `tools/yt-dlp`; the newest version is downloaded with the next video. |

Where the app keeps its data:
- Windows: `%APPDATA%\TurboDL`
- macOS: `~/Library/Application Support/TurboDL`

This folder holds the settings, the download list, the video tools and the browser launcher (`native-host/`). The download list also contains cookies from sites that need a login.

## Architecture

```
packages/shared   Code shared by the extension and the app (protocol types, categories, file names, capture and clipboard decisions)
apps/desktop      Electron app
  src/main        Download engine (engine/), queue (manager), scheduler, yt-dlp and cookie file (media/),
                  bridge server, clipboard watcher, browser launcher registration (native-host.ts)
  src/renderer    React UI
  resources/native-host/host.cjs   Launcher the browser runs (the app's own executable runs it in Node mode)
apps/extension    MV3 extension (bundled with esbuild)
```

- **Connection:** The extension and the app talk over `127.0.0.1:47123`. The app only accepts requests from the TurboDL extension's ID (`Origin` header).
- **When the app is closed:** The extension runs the `com.turbodl.host` launcher through the browser's native messaging. The launcher starts TurboDL in the background.
  - The app registers this launcher every time it starts.
  - On Windows it is registered under the `HKCU\Software\…\NativeMessagingHosts` keys.
  - On macOS it is written to each browser's `NativeMessagingHosts` folder.
- **Cookies:** They reach yt-dlp through a temporary cookie file (`--cookies`), scoped by domain and deleted afterwards. Cookies are never passed as a header.
