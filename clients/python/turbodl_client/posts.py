"""Instagram posts, as `TurboDL.posts()` yields them."""

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_TIME = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$")


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
