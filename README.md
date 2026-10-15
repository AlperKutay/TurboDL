# TurboDL

A download manager for Windows and macOS, inspired by IDM. It comes with a browser extension for Chrome, Edge and Brave.

## Features

- **Fast downloads** — files are split into parts and downloaded over several connections at once.
- **Resume** — unfinished downloads continue where they left off, even after a restart.
- **Browser integration** — clicking a download link hands it to TurboDL. If TurboDL is closed, the extension starts it.
- **Video downloads** — a "⬇ TurboDL" button appears on videos. HLS/DASH streams are downloaded by TurboDL itself; for sites like YouTube, [yt-dlp](https://github.com/yt-dlp/yt-dlp) finds the video addresses. You choose the quality.
- **Queue and scheduler** — start downloads at a set time and shut down or sleep the computer when they finish.
- **Automatic sorting** — files go into Video, Music, Programs, Archives, Documents, Images and Other folders.
- **Clipboard** — copying a download link offers to download it.

## Build and install

You need Node.js 22 or newer, pnpm 11 and git.

```bash
pnpm install
pnpm dist
```

The installer is created in `apps/desktop/release/` (`.exe` on Windows, `.dmg` on macOS). The app is not signed, so Windows and macOS show a warning the first time you open it.

### Browser extension

1. In TurboDL, open **Settings → Install the browser extension…**. The extension is copied to `Documents/TurboDL Extension`.
2. Open `chrome://extensions` (Chrome, Brave) or `edge://extensions` (Edge).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the `TurboDL Extension` folder.

Open TurboDL once after installing; from then on the extension can start it.

## Development

```bash
pnpm dev         # run the app in development mode
pnpm test        # unit and integration tests
pnpm typecheck   # type check
pnpm e2e         # end-to-end tests (needs: pnpm --filter @turbodl/extension exec playwright install chromium)
```

## Project structure

```
packages/shared    code shared by the app and the extension
apps/desktop       Electron app (download engine, video engine, UI)
apps/extension     browser extension (Manifest V3)
```

## Notes

- yt-dlp and Deno are downloaded on first use. ffmpeg is bundled through [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static). These tools have their own licenses.
- DRM-protected videos cannot be downloaded. Respect the terms of the sites you download from.
- TurboDL is not affiliated with Internet Download Manager.

## License

[MIT](LICENSE)
