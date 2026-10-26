# TurboDL

A download manager for Windows and macOS, inspired by IDM. It comes with a browser extension for Chrome, Edge, Brave, Opera, Vivaldi, Arc and Firefox.

## Features

- **Fast downloads** — files are split into parts and downloaded over several connections at once.
- **Resume** — unfinished downloads continue where they left off, even after a restart.
- **Browser integration** — clicking a download link hands it to TurboDL. If TurboDL is closed, the extension starts it.
- **Instagram** — posts, reels, stories and highlights from a link; your saved posts and collections; a profile's posts and highlights. Pick what you want, or back a collection, profile or its highlights up into a folder, where later backups only save what is new.
- **Video downloads** — a "⬇ TurboDL" button appears on videos. HLS/DASH streams are downloaded by TurboDL itself; for sites like YouTube, [yt-dlp](https://github.com/yt-dlp/yt-dlp) finds the video addresses. You choose the quality.
- **Queue and scheduler** — start downloads at a set time and shut down or sleep the computer when they finish.
- **Automatic sorting** — files go into Video, Music, Programs, Archives, Documents, Images and Other folders.
- **Clipboard** — copying a download link offers to download it.
- **Notifications** — clicking "Download complete" shows the file in File Explorer or Finder.

## Command line

The installed app comes with a `turbodl` command. Open **Settings → Command line → Install command line tool** to add it to your PATH (on macOS it asks for an administrator password to link it into `/usr/local/bin`), then open a new terminal. **Remove** takes it away again. TurboDL starts by itself if it is not running.

```bash
turbodl get https://example.com/file.zip                    # download and wait until it finishes
turbodl get https://www.instagram.com/someone/              # a profile's posts
turbodl get https://www.instagram.com/someone/ --highlights # ... and its highlights
turbodl get https://www.instagram.com/someone/ --highlights-only
turbodl get https://www.instagram.com/someone/saved/ --collection "Travel"   # a Saved collection (repeat the option, or use --all-collections)
turbodl get https://x.com/someone/status/123 --dir ~/Videos # an X link into a folder
turbodl add https://example.com/a.zip https://example.com/b.zip   # queue and return at once; prints the job ids
turbodl wait <id> [<id>...]                                 # wait until queued jobs finish
turbodl list                                                # all jobs
turbodl status <id>                                         # one job
turbodl cancel <id>                                         # cancel a job
turbodl instagram login | logout | status                   # the Instagram sign-in
```

Other options for `get` and `add`: `--name <file>` (one link only), `--audio`, `--max-height <px>`. Run `turbodl --help` for the full list.

- Instagram downloads always go to TurboDL's Instagram folders, whatever `--dir` says.
- Without signing in (`turbodl instagram login`), a profile gives only the first posts Instagram shows visitors, and the command ends with exit code 3.
- `--json` prints one JSON object per line, for scripts.
- Ctrl+C cancels the jobs that `get` is waiting for; a second Ctrl+C gives up at once.

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Failed |
| 2 | Usage mistake |
| 3 | Instagram sign-in needed |
| 4 | Instagram asked TurboDL to slow down |
| 5 | TurboDL could not be reached |
| 6 | Stopped in TurboDL or by another client |
| 130 | Ctrl+C |

### Local API

Other programs can use the same engine. While TurboDL runs it writes `api.json` in its user data folder (`%APPDATA%\TurboDL` on Windows, `~/Library/Application Support/TurboDL` on macOS) with the port and an access token. Send requests to `127.0.0.1` on that port with the header `Authorization: Bearer <token>`: `POST /v1/jobs` starts a job, and `GET /v1/jobs/<id>/events` streams its progress as newline-delimited JSON. The API listens on this computer only; keep the token private.

## Download

Installers for Windows and macOS and the Firefox add-on are on the [Releases](https://github.com/AlperKutay/TurboDL/releases) page.

## Build from source

You need Node.js 22 or newer, pnpm 11 and git.

```bash
pnpm install
pnpm dist
```

The installer is created in `apps/desktop/release/` (`.exe` on Windows, `.dmg` on macOS). The app is not signed, so Windows and macOS show a warning the first time you open it.

### Browser extension

Chrome, Edge, Brave, Opera, Vivaldi and Arc:

1. In TurboDL, open **Settings → Install the browser extension…**. The extension is copied to `Documents/TurboDL Extension`.
2. Open the browser's extensions page: `chrome://extensions` (Chrome, Brave, Vivaldi, Arc), `edge://extensions` (Edge) or `opera://extensions` (Opera).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Choose the `TurboDL Extension` folder.

Firefox: open the `.xpi` file from the [Releases](https://github.com/AlperKutay/TurboDL/releases) page in Firefox. Regular Firefox only installs add-ons signed by Mozilla; an unsigned build works in Firefox Developer Edition, Nightly and ESR with `xpinstall.signatures.required` set to `false`.

Open TurboDL once after installing; from then on the extension can start it.

Safari is not supported.

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
- Instagram features use your own Instagram session (stored encrypted). TurboDL paces its requests and stops when Instagram asks it to slow down, but Instagram may still limit accounts that download a lot.
- TurboDL is not affiliated with Internet Download Manager.

## License

[MIT](LICENSE)
