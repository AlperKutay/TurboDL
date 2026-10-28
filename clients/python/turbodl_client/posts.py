"""Instagram posts, as `TurboDL.posts()` lists them."""

import re
from datetime import datetime, timezone
from typing import Any, Dict, Generator, Iterator, List, Optional

from .errors import AppNotReachable, TurboDLError
from .job import Job

_TIME = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$")
LOST = "Lost TurboDL while listing posts."


def _opt_int(value: Any) -> Optional[int]:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _opt_float(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _opt_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def parse_time(value: Any) -> Optional[datetime]:
    """An ISO 8601 string from the API as an aware UTC datetime; None for null or anything unreadable."""
    if not isinstance(value, str):
        return None
    m = _TIME.match(value)
    if m is None:
        return None
    base, fraction, zone = m.groups()
    text = base + ("." + (fraction + "000000")[:6] if fraction else "")
    text += "+00:00" if zone in (None, "Z") else zone
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc)
    except ValueError:
        return None


class PostItem:
    """One photo or video of a post."""

    def __init__(self, kind: str, url: str, media_id: Optional[str] = None, width: Optional[int] = None,
                 height: Optional[int] = None, duration: Optional[float] = None) -> None:
        self.kind = kind
        self.url = url
        self.media_id = media_id
        self.width = width
        self.height = height
        self.duration = duration

    @classmethod
    def from_api(cls, d: Dict[str, Any]) -> "PostItem":
        return cls(str(d.get("kind", "")), str(d.get("url", "")), _opt_str(d.get("mediaId")),
                   _opt_int(d.get("width")), _opt_int(d.get("height")), _opt_float(d.get("duration")))

    def __repr__(self) -> str:
        return "PostItem(kind=%r, url=%r)" % (self.kind, self.url)


class Post:
    """One Instagram post; `known` and `sign_in_only` posts come without items."""

    def __init__(self, code: str, url: str, taken_at: Optional[datetime] = None, pinned: bool = False,
                 owner: Optional[str] = None, caption: Optional[str] = None,
                 tagged_users: Optional[List[str]] = None, sign_in_only: bool = False, known: bool = False,
                 items: Optional[List[PostItem]] = None) -> None:
        self.code = code
        self.url = url
        self.taken_at = taken_at
        self.pinned = pinned
        self.owner = owner
        self.caption = caption
        self.tagged_users = list(tagged_users or [])  # type: List[str]
        self.sign_in_only = sign_in_only
        self.known = known
        self.items = list(items or [])  # type: List[PostItem]

    @classmethod
    def from_api(cls, d: Dict[str, Any]) -> "Post":
        tagged = d.get("taggedUsers")
        items = d.get("items")
        return cls(str(d.get("code", "")), str(d.get("url", "")), parse_time(d.get("takenAt")),
                   bool(d.get("pinned", False)), _opt_str(d.get("owner")), _opt_str(d.get("caption")),
                   [u for u in tagged if isinstance(u, str)] if isinstance(tagged, list) else [],
                   bool(d.get("signInOnly", False)), bool(d.get("known", False)),
                   [PostItem.from_api(i) for i in items if isinstance(i, dict)] if isinstance(items, list) else [])

    def __repr__(self) -> str:
        return "Post(code=%r, items=%d)" % (self.code, len(self.items))


class PostList(Iterator[Post]):
    """The posts of a list job as they arrive; `job` is the Job followed, kept up to date as its events come in.

    `TurboDL.posts()` makes it with the job's events stream already open (the app reads nothing for a list nobody
    follows). Once the posts are read, `job.warnings` and `job.failed_items` (posts whose page showed nothing) tell what
    was left out. When the list ends other than `done`, iterating raises as `Job.wait()` does; a stream that breaks
    raises AppNotReachable (no reconnect). `close()`, leaving the loop early or Ctrl+C cancels a list that hasn't
    ended."""

    def __init__(self, client: Any, job: Job) -> None:
        self.job = job
        self._client = client
        self._open = False
        self._seen = []  # type: List[str]
        self._pending = None  # type: Optional[Dict[str, Any]]  # an event read ahead, not yet handled
        self._stream = client._stream(job.id, None)  # type: Generator[Dict[str, Any], None, None]
        self._open = True
        try:
            first = next(self._stream, None)  # the job's snapshot: the stream is followed from here on
            if first is None:
                raise AppNotReachable(LOST, job)
            if first.get("type") == "job":
                job._apply(first, self._seen)
            else:
                self._pending = first
        except BaseException:
            self.close()
            raise

    def __iter__(self) -> "PostList":
        return self

    def __next__(self) -> Post:
        if not self._open:
            raise StopIteration
        try:
            while True:
                event = self._next_event()
                if event is None:
                    self._stop_reading()
                    raise AppNotReachable(LOST, self.job)
                if event.get("type") == "post" and isinstance(event.get("post"), dict):
                    return Post.from_api(event["post"])
                self.job._apply(event, self._seen)
                if event.get("type") == "end":
                    self._stop_reading()
                    self.job._finish()
                    raise StopIteration
        except KeyboardInterrupt:
            self.close()
            raise

    def close(self) -> None:
        """Stops reading; a list that hasn't ended is cancelled."""
        if not self._open:
            return
        self._stop_reading()
        if not self.job.ended:
            try:
                self._client._cancel_raw(self.job.id)
            except TurboDLError:
                pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _next_event(self) -> Optional[Dict[str, Any]]:
        if self._pending is not None:
            event, self._pending = self._pending, None
            return event
        return next(self._stream, None)

    def _stop_reading(self) -> None:
        self._open = False
        self._stream.close()

    def __repr__(self) -> str:
        return "PostList(job=%r)" % (self.job,)
