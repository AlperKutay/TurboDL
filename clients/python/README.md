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

## Instagram posts

`TurboDL.posts(url, since=None, limit=None, known=None)` lists the posts of an Instagram profile or post as `Post` objects (with `PostItem` photos and videos), as TurboDL finds them. It returns a `PostList`: iterate it for the posts; its `job` follows the list, and after the loop `job.failed_items` counts the posts whose page showed nothing. It needs TurboDL 0.8.0 or newer, and raises `SignInRequired` after the posts it could get when the rest needs a sign-in.

```python
from turbodl_client import TurboDL

posts = TurboDL().posts("https://www.instagram.com/someone/", limit=20)
for post in posts:
    print(post.code, post.taken_at, [item.url for item in post.items])
print(posts.job.failed_items, "posts showed nothing")
```
