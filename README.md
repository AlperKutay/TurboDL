# TurboDL

A download manager for Windows and macOS, inspired by IDM. It comes with a browser extension for Chrome, Edge, Brave, Opera, Vivaldi, Arc and Firefox.

## Features

- **Fast downloads** — files are split into parts and downloaded over several connections at once.
- **Resume** — unfinished downloads continue where they left off, even after a restart.
- **Browser integration** — clicking a download link hands it to TurboDL. If TurboDL is closed, the extension starts it.
- **Instagram** — posts, reels, stories and highlights from a link; your saved posts and collections; a profile's posts and highlights. Pick what you want, or back a collection, profile or its highlights up into a folder, where later backups only save what is new. Public profiles and their highlights work without signing in; that is slower, as TurboDL reads each post from its own page, a few seconds apart: a 50-post profile takes a few minutes; a 1,000-post profile takes hours. Saved, current stories, posts Instagram shows only to signed-in visitors and private profiles still need a sign-in.
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
turbodl get https://x.com/someone/status/123 --dir D:\Videos   # an X link into a folder
turbodl posts https://www.instagram.com/someone/ --since 2026-01-01 --limit 20   # list a profile's posts, save nothing
turbodl add https://example.com/a.zip https://example.com/b.zip   # queue and return at once; prints the job ids
turbodl wait <id> [<id>...]                                 # wait until queued jobs finish
turbodl list                                                # all jobs
turbodl status <id>                                         # one job
turbodl cancel <id>                                         # cancel a job
turbodl instagram login | logout | status                   # the Instagram sign-in
```

Other options for `get` and `add`: `--name <file>` (one link only), `--audio`, `--max-height <px>`. Run `turbodl --help` for the full list.

- Instagram downloads always go to TurboDL's Instagram folders, whatever `--dir` says.
- Profiles and highlights work without signing in, more slowly (each post is read from its own page). Posts Instagram shows only to signed-in visitors are skipped: the rest are saved, and the command ends with exit code 3. Saved, story links and private profiles need `turbodl instagram login`.
- `turbodl posts <link>` lists an Instagram profile's or post's posts without saving anything: one line per post with its code, time and item count (`pinned`, `sign-in only` or `known` follow when they apply). `--since <ISO time>` (`2026-01-01`, read as UTC, or a time ending in `Z` or `+02:00`) stops at the first post taken at or before it; `--limit <n>` caps the posts listed. Tagged users are read signed out too.
- `--json` prints one JSON object per line, for scripts.
- Ctrl+C in `get` or `wait` cancels the jobs it is waiting for; a second Ctrl+C gives up at once.

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Failed |
| 2 | Usage mistake |
| 3 | Instagram sign-in needed, or some of a profile's posts are shown only to signed-in visitors (the rest were saved) |
| 4 | Instagram asked TurboDL to slow down |
| 5 | TurboDL could not be reached |
| 6 | Stopped in TurboDL or by another client |
| 130 | Ctrl+C |

### Local API

Other programs can use the same engine. While TurboDL runs it writes `api.json` in its user data folder (`%APPDATA%\TurboDL` on Windows, `~/Library/Application Support/TurboDL` on macOS) with the port and an access token. Send requests to `127.0.0.1` on that port with the header `Authorization: Bearer <token>`: `POST /v1/jobs` starts a job, and `GET /v1/jobs/<id>/events` streams its progress as newline-delimited JSON. The API listens on this computer only; keep the token private. `GET /v1/info` lists `"features": ["posts"]` when the app can list posts.

**Post lists.** `POST /v1/jobs` with `options.postsOnly: true` lists a profile's or a post or reel link's posts and saves nothing. Optional `since` (`YYYY-MM-DD` as UTC, or a date-time with `Z` or `±HH:MM`), `limit` (1 to 100000) and `known` (up to 10000 shortcodes, sent back as stubs without being read). `postsOnly` can't be combined with `highlights`, `highlightsOnly`, `collections` or `allCollections` (400). Each post is an event:

```json
{"type":"post","post":{"code":"…","url":"…","takenAt":"2026-01-02T03:04:05.000Z","pinned":false,"owner":"…","caption":"…","taggedUsers":[],"items":[{"kind":"video","url":"…","mediaId":"…","width":1080,"height":1920,"duration":12.5}]}}
```

`takenAt` is an ISO time or `null`; `caption`, `signInOnly` and `known` appear only when they apply; an item's `mediaId`, `width`, `height` and `duration` can be missing (reels signed out often have no `duration`). The list stops at the first post taken at or before `since` after the first 3 positions (signed out, Instagram shows no pinned mark, so up to 3 old posts at the top are sent). It ends with `done`; `done` with `limited` and a warning when some posts are shown only to signed-in visitors; or `failed` with `rateLimited`, `private`, `unsupported` (stories, highlights, Saved and other sites) or `error`. A list nobody follows for 60 seconds is cancelled.

## Python

`turbodl-client` is a small Python package (3.9 or newer, standard library only) for the same local API. TurboDL must be installed and opened once on this computer; after that the package starts it by itself when it is closed.

```bash
pip install "git+https://github.com/AlperKutay/TurboDL#subdirectory=clients/python"
```

```python
from turbodl_client import TurboDL, SignInRequired

tdl = TurboDL()                      # TurboDL(user_data=None, start=True, timeout=30)
try:
    job = tdl.get("https://www.instagram.com/nasa/", highlights=True)    # waits; returns a Job
except SignInRequired as e:          # signed out: some posts are shown only to signed-in visitors
    job = e.job
print(job.files)

job = tdl.add("https://x.com/someone/status/123", dir=r"D:\Video")   # returns at once
for event in job.events():           # dicts, as the API sends them
    print(event)
job.wait()

for post in tdl.posts("https://www.instagram.com/nasa/", since="2026-01-01", limit=20):
    print(post.code, post.taken_at, len(post.items))    # lists posts, saves nothing

tdl.jobs(); tdl.job(job.id); tdl.cancel(job.id)
tdl.instagram_login(); tdl.instagram_logout(); tdl.info()
```

- Options are the command's, in snake_case: `dir`, `name`, `audio`, `max_height`, `highlights`, `highlights_only`, `collections`, `all_collections`. A relative `dir` is resolved against the process's current working directory.
- `get()` and `Job.wait()` return the `Job` when it ends `done` and raise otherwise; a `limited` job (a profile saved without signing in, all but the posts Instagram shows only to signed-in visitors) ends `done` but still raises `SignInRequired`. The exceptions for how a job ended, and `AppNotReachable` when TurboDL quits during `get()`, `wait()` or `events()`, carry the job as `e.job`, with the files already saved. All derive from `TurboDLError`.
- `posts(url, since=None, limit=None, known=None)` is eager: it checks the app and starts the list when called, then yields `Post` objects: `code`, `url`, `taken_at` (aware UTC or `None`), `pinned`, `owner`, `caption`, `tagged_users`, `sign_in_only`, `known` and `items`, a list of `PostItem` (`kind`, `url`, `media_id`, `width`, `height`, `duration`). It doesn't reconnect: a stream that breaks raises `AppNotReachable`. The exceptions below are raised at the end (`SignInRequired` after all posts when some were shown only to signed-in visitors). Closing the iterator early or Ctrl+C cancels the job. An app older than 0.8.0 raises `TurboDLError("Update TurboDL to 0.8.0 or newer to list posts.")`.
- `wait(timeout=...)` raises the built-in `TimeoutError` when the time is up and leaves the job running; `get()` waits as long as the job runs.

| Exception | Raised when |
| --- | --- |
| `SignInRequired` | Instagram needs a sign-in to save everything (also when some of a profile's posts are shown only to signed-in visitors) |
| `RateLimited` | The site asked TurboDL to slow down |
| `JobFailed` | The download failed (`reason` says why) |
| `Cancelled` | The job was stopped in TurboDL or by another client (`reason` is `"stopped"`), or by this process (`reason` is `None`) |
| `AppNotReachable` | TurboDL is not installed or opened yet, did not start in time, or quit while a job was running |

- Ctrl+C (`KeyboardInterrupt`) inside `get()` or `wait()` cancels the job, then raises again.
- The package finds TurboDL through `api.json` in its user data folder. Pass `TurboDL(user_data="...")` or set the `TURBODL_USER_DATA` environment variable to use another folder.

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
- Signed in, Instagram features use your own Instagram session (stored encrypted). TurboDL paces its requests and stops when Instagram asks it to slow down, but Instagram may still limit accounts (or, signed out, this computer) that download a lot.
- TurboDL is not affiliated with Internet Download Manager.

## License

[MIT](LICENSE)
