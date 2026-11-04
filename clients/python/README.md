# turbodl-client

Python client for the local API of the TurboDL download manager: queue a link, follow it, get the files.

Install it from GitHub:

```bash
pip install "git+https://github.com/AlperKutay/TurboDL#subdirectory=clients/python"
```

or from a checkout of the repo with `pip install ./clients/python`. See the repo README for the API and the `turbodl` command.

## Choosing what a profile backup saves

`TurboDL.add()` and `TurboDL.get()` take `posts=True`, `tagged=False`, `photos=True` and `videos=True` for Instagram profile links: `posts=False` leaves out the profile's own posts (use it with `highlights=True` or `tagged=True`), `tagged=True` adds the posts the profile is tagged in (needs a sign-in), and `photos=False` or `videos=False` saves only the other kind. They need TurboDL 0.9.0 or newer; an older app raises `TurboDLError`.

```python
TurboDL().get("https://www.instagram.com/someone/", videos=False, tagged=True)
```

## Backing up a list of profiles

`TurboDL.backup_profiles(profiles, wait=(2, 5), *, posts=True, highlights=False, tagged=False, photos=True, videos=True, name=None)` starts the app's list of profiles, the same one its Profiles screen shows: TurboDL backs them up one after another, waiting a random number of minutes between two of them (`wait` is `(least, most)` in whole minutes, or one number). `profiles` is a list of names, `@names` or profile links; a single string raises `TypeError`. The save options are the ones `add()` takes, with the same defaults, and each one is sent to the app as given. The app runs one list at a time and refuses a second while one is unfinished. It needs TurboDL 0.9.0 or newer; an older app raises `TurboDLError`.

It returns a `ProfileListRun`. `wait(poll=2.0, timeout=None)` reads the list every `poll` seconds until it no longer goes on by itself and returns it as a dict, whatever way it ended: its `state` is `finished`, `stopped`, `rateLimited` (Instagram asked to slow down too often) or `signedOut`, and each of its `rows` has the `username` and the row's `state` (`done`, `skipped` or `failed`, with a `note` saying why). `timeout` raises `TimeoutError` and leaves the list running; Ctrl+C stops the list. `refresh()` reads it once, `stop()` stops it (the app keeps it, to continue).

`read_profile_list(path)` reads a `.txt` of profiles as the app does: one per line, as a name, an `@name` or a profile link; blank lines and `#` comments are skipped and a name written twice is kept once. A line that isn't a profile raises `ValueError` naming it.

```python
from turbodl_client import TurboDL, read_profile_list

run = TurboDL().backup_profiles(read_profile_list("profiles.txt"), wait=(3, 8), videos=False)
done = run.wait()
for row in done["rows"]:
    print(row["username"], row["state"], row.get("note", ""))
```

## Instagram posts

`TurboDL.posts(url, since=None, limit=None, known=None)` lists the posts of an Instagram profile or post as `Post` objects (with `PostItem` photos and videos), as TurboDL finds them. It returns a `PostList`: iterate it for the posts; its `job` follows the list, and after the loop `job.failed_items` counts the posts whose page showed nothing. It needs TurboDL 0.8.0 or newer, and raises `SignInRequired` after the posts it could get when the rest needs a sign-in.

```python
from turbodl_client import TurboDL

posts = TurboDL().posts("https://www.instagram.com/someone/", limit=20)
for post in posts:
    print(post.code, post.taken_at, [item.url for item in post.items])
print(posts.job.failed_items, "posts showed nothing")
```
