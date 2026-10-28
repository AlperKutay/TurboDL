# turbodl-client

Python client for the local API of the TurboDL download manager: queue a link, follow it, get the files.

Install it from GitHub:

```bash
pip install "git+https://github.com/AlperKutay/TurboDL#subdirectory=clients/python"
```

or from a checkout of the repo with `pip install ./clients/python`. See the repo README for the API and the `turbodl` command.

## Instagram posts

`TurboDL.posts(url, since=None, limit=None, known=None)` lists the posts of an Instagram profile or post as `Post` objects (with `PostItem` photos and videos), as TurboDL finds them. It needs TurboDL 0.8.0 or newer, and raises `SignInRequired` after the posts it could get when the rest needs a sign-in.

```python
from turbodl_client import TurboDL

for post in TurboDL().posts("https://www.instagram.com/someone/", limit=20):
    print(post.code, post.taken_at, [item.url for item in post.items])
```
