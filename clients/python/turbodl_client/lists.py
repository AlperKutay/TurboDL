"""Lists of Instagram profiles: reading a .txt of them as the app does, and following a list the app runs."""

import os
import re
import time
from typing import Any, Dict, List, Optional, Union
from urllib.parse import urlsplit

from .errors import AppNotReachable, TurboDLError

# The states in which a list goes on by itself.
GOES_ON = ("running", "waiting", "slowedDown")
CLOSED = "The list was closed in TurboDL."

# What JavaScript's trim() takes off (Python's strip() differs: it keeps U+FEFF and takes U+001C-U+001F and U+0085).
_JS_SPACE = ("\t\n\v\f\r              "
             "    　﻿")
_LINE_BREAK = re.compile(r"\r\n|\n|\r")
_LINK = re.compile(r"https?://", re.IGNORECASE | re.ASCII)
_USERNAME = re.compile(r"[a-z0-9._]{1,30}", re.IGNORECASE | re.ASCII)
# Instagram's own first path parts, which are never usernames.
_RESERVED = frozenset([
    "p", "reel", "reels", "tv", "stories", "s", "explore", "accounts", "direct", "about", "legal", "developer", "web",
    "api", "challenge", "emails", "privacy", "terms", "ar", "music", "audio", "locations", "topics",
])
_POST_PARTS = ("p", "reel", "reels", "tv")
_DOT = (".", "%2e")
_DOT_DOT = ("..", ".%2e", "%2e.", "%2e%2e")
_C0_OR_SPACE = "".join(chr(c) for c in range(0x21))


def _path_parts(path: str) -> List[str]:
    """The non-empty parts of a URL path once `.` and `..` are resolved, as a browser resolves them."""
    parts = []  # type: List[str]
    for part in path.split("/"):
        lowered = part.lower()
        if lowered in _DOT:
            continue
        if lowered in _DOT_DOT:
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return [p for p in parts if p]


def _link_username(address: str) -> Optional[str]:
    """The username of an Instagram profile link (`/name/`, `/name/reels/`, `/name/tagged/`); None for any other."""
    # as a browser reads an address: control characters and spaces around it and tabs and line breaks in it dropped,
    # `\` read as `/` in an http(s) one
    address = re.sub(r"[\t\n\r]", "", address.strip(_C0_OR_SPACE)).replace("\\", "/")
    try:
        u = urlsplit(address)
        host = (u.hostname or "").lower()
        u.port  # raises ValueError for a port that isn't one
    except ValueError:
        return None
    if host != "instagram.com" and not host.endswith(".instagram.com"):
        return None
    parts = _path_parts(u.path)
    post_at = next((i for i, p in enumerate(parts) if p in _POST_PARTS), -1)
    if 0 <= post_at <= 1 and post_at + 1 < len(parts):
        return None  # a post, under a username or not
    name = parts[0].lower() if parts else ""
    if not name or name in _RESERVED or not _USERNAME.fullmatch(name):
        return None
    if len(parts) == 1 or (len(parts) == 2 and parts[1] in ("reels", "tagged")):
        return name
    return None


def profile_name(text: str) -> Optional[str]:
    """The username in a profile link or in a typed name (`@` or not), lowercased; None for anything else."""
    typed = text.strip(_JS_SPACE)
    if _LINK.match(typed):
        return _link_username(typed)
    name = typed[1:] if typed.startswith("@") else typed
    return name.lower() if _USERNAME.fullmatch(name) else None


def read_profile_list(path: Union[str, "os.PathLike[str]"]) -> List[str]:
    """The profiles a .txt lists, as TurboDL reads it: one per line, as a name, an `@name` or a profile link.

    Blank lines and `#` comments are skipped, a name written twice is kept once (in its first place), and the
    names come lowercased. A line that isn't a profile raises ValueError naming every such line ("Line 3 isn't a
    profile: …"). The app takes at most 1000 profiles in a list; `TurboDL.backup_profiles()` raises for more."""
    with open(path, "rb") as f:
        text = f.read().decode("utf-8", "replace")
    if text.startswith("﻿"):
        text = text[1:]
    names = []  # type: List[str]
    seen = set()
    invalid = []  # type: List[str]
    for number, raw in enumerate(_LINE_BREAK.split(text), 1):
        line = raw.strip(_JS_SPACE)
        if not line or line.startswith("#"):
            continue
        name = profile_name(line)
        if name is None:
            invalid.append("Line %d isn't a profile: %s" % (number, line))
        elif name not in seen:
            seen.add(name)
            names.append(name)
    if invalid:
        raise ValueError("; ".join(invalid))
    return names


class ProfileListRun:
    """The profile list `TurboDL.backup_profiles()` started; `list` is the API's view of it as last read.

    The view is a dict as the API sends it: `name`, `state` (running, waiting, slowedDown, stopped, signedOut,
    rateLimited or finished), `index`, `rows` (each with `username`, `state` (waiting, running, done, skipped or
    failed) and maybe `note`, `files`, `fetched`), `options`, `wait`, and maybe `nextAt`, `message`, `progress`."""

    def __init__(self, client: Any, data: Dict[str, Any]) -> None:
        self._client = client
        self.list = data  # type: Dict[str, Any]

    @property
    def state(self) -> str:
        return str(self.list.get("state", ""))

    def refresh(self) -> Dict[str, Any]:
        """Reads the list again; TurboDLError when it was closed in the app. A cut connection is tried again once,
        on the port api.json names (the app may have moved); AppNotReachable("TurboDL quit.") when that fails too."""
        try:
            data = self._client._call("GET", "/v1/lists/current")
        except AppNotReachable:
            if not self._client._reconnect():
                raise AppNotReachable("TurboDL quit.") from None
            data = self._client._call("GET", "/v1/lists/current")
        return self._set(data)

    def stop(self) -> Dict[str, Any]:
        """Stops the list; the app keeps it, to continue from the Profiles screen. Returns it as it stopped."""
        return self._set(self._client._call("POST", "/v1/lists/current/stop", {}))

    def wait(self, poll: float = 2.0, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Reads the list every `poll` seconds until it no longer goes on by itself, and returns it then.

        Unlike `Job.wait()` nothing is raised for how it ended: look at `state` (finished, or stopped, rateLimited
        after Instagram asked to slow down too often, signedOut) and at each row's `state`. `timeout` (seconds) raises
        TimeoutError and leaves the list running; Ctrl+C stops the list and is re-raised."""
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while self.state in GOES_ON:
                if deadline is not None:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError()
                    time.sleep(min(poll, left))
                else:
                    time.sleep(poll)
                self.refresh()
        except KeyboardInterrupt:
            try:
                self.stop()
            except TurboDLError:
                pass
            raise
        return self.list

    def _set(self, data: Any) -> Dict[str, Any]:
        view = data.get("list") if isinstance(data, dict) else None
        if not isinstance(view, dict):
            raise TurboDLError(CLOSED)
        self.list = view
        return view

    def __repr__(self) -> str:
        return "ProfileListRun(name=%r, state=%r)" % (self.list.get("name"), self.state)


__all__ = ["ProfileListRun", "read_profile_list", "profile_name"]
