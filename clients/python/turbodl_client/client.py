"""The TurboDL client: finds the app, starts it when needed, and talks to its local API."""

import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Generator, Iterable, Iterator, List, Optional, Set, Union

from . import _discover
from ._http import request, stream_lines
from .errors import AppNotReachable, TurboDLError
from .job import Job
from .posts import Post

API_VERSION = 1
# When an events stream closes without `end`, how long the app gets to answer again before it counts as quit.
RECONNECT_WINDOW = 5.0
RECONNECT_POLL = 0.25


def _iso_utc(moment: datetime) -> str:
    """`YYYY-MM-DDTHH:MM:SS[.ffffff]Z` in UTC; a naive datetime is taken as UTC."""
    moment = (moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment).astimezone(timezone.utc)
    fraction = ".%06d" % moment.microsecond if moment.microsecond else ""
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + fraction + "Z"


class TurboDL:
    """A connection to the running TurboDL; starts the app when it isn't running (unless `start=False`)."""

    def __init__(self, user_data: Optional[str] = None, start: bool = True, timeout: float = 30.0) -> None:
        self._folder = _discover.user_data_dir(user_data)
        self._start = start
        self._timeout = timeout
        self._cancelled = set()  # type: Set[str]  # ids this client cancelled
        self._port, self._token = _discover.connect(self._folder, start, timeout)
        api = self.info().get("api")
        if api != API_VERSION:
            raise TurboDLError("This turbodl-client speaks API %d, but TurboDL speaks API %s. Update turbodl-client."
                               % (API_VERSION, api))

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: Optional[float] = 60.0) -> Any:
        return request(self._port, self._token, method, path, body, timeout)

    def info(self) -> Dict[str, Any]:
        """The app's name, version, API version and Instagram sign-in state."""
        return self._call("GET", "/v1/info")

    def add(self, url: str, dir: Optional[str] = None, name: Optional[str] = None, *, audio: bool = False,
            max_height: Optional[int] = None, highlights: bool = False, highlights_only: bool = False,
            collections: Optional[List[str]] = None, all_collections: bool = False) -> Job:
        """Queues a link and returns its job at once."""
        options = {}  # type: Dict[str, Any]
        if audio:
            options["audio"] = True
        if max_height is not None:
            options["maxHeight"] = max_height
        if highlights:
            options["highlights"] = True
        if highlights_only:
            options["highlightsOnly"] = True
        if collections:
            options["collections"] = list(collections)
        if all_collections:
            options["allCollections"] = True
        body = {"url": url}  # type: Dict[str, Any]
        if dir is not None:
            body["dir"] = os.path.abspath(dir)
        if name is not None:
            body["name"] = name
        if options:
            body["options"] = options
        return Job(self._call("POST", "/v1/jobs", body)["job"], self)

    def job(self, id: str) -> Job:
        return Job(self._fetch(id), self)

    def jobs(self) -> List[Job]:
        return [Job(j, self) for j in self._call("GET", "/v1/jobs")["jobs"]]

    def cancel(self, id: str) -> Job:
        return Job(self._cancel_raw(id), self)

    def _fetch(self, id: str) -> Dict[str, Any]:
        return self._job_call("GET", "/v1/jobs/" + id, id)

    def _cancel_raw(self, id: str) -> Dict[str, Any]:
        self._cancelled.add(id)
        return self._job_call("POST", "/v1/jobs/" + id + "/cancel", id)

    def _job_call(self, method: str, path: str, id: str) -> Dict[str, Any]:
        return request(self._port, self._token, method, path, not_found="No job %s." % id)["job"]

    def _stream(self, id: str, deadline: Optional[float]) -> Generator[Dict[str, Any], None, None]:
        return stream_lines(self._port, self._token, "/v1/jobs/" + id + "/events", deadline, "No job %s." % id)

    def _reconnect(self, deadline: Optional[float] = None) -> bool:
        """Looks api.json up again (the app may have restarted on another port) for up to RECONNECT_WINDOW seconds;
        raises TimeoutError when `deadline` comes first."""
        began = time.monotonic()
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError()
            file = _discover.read_api_file(self._folder)
            if file is not None and file.get("port") is not None and _discover._ping(file["port"], file["token"]):
                self._port, self._token = file["port"], file["token"]
                return True
            if time.monotonic() - began >= RECONNECT_WINDOW:
                return False
            time.sleep(RECONNECT_POLL)

    def get(self, url: str, dir: Optional[str] = None, name: Optional[str] = None, *, audio: bool = False,
            max_height: Optional[int] = None, highlights: bool = False, highlights_only: bool = False,
            collections: Optional[List[str]] = None, all_collections: bool = False,
            on_event: Optional[Callable[[Dict[str, Any]], None]] = None) -> Job:
        """Queues a link and waits for it: the finished Job, or the exception for how it ended."""
        job = self.add(url, dir, name, audio=audio, max_height=max_height, highlights=highlights,
                       highlights_only=highlights_only, collections=collections, all_collections=all_collections)
        return job.wait(on_event=on_event)

    def posts(self, url: str, since: Union[datetime, str, None] = None, limit: Optional[int] = None,
              known: Optional[Iterable[str]] = None) -> Iterator[Post]:
        """The posts of an Instagram profile or post, as TurboDL finds them (a generator: nothing starts before the
        first `next`).

        `since` is a datetime (naive means UTC) or an ISO 8601 string; `known` holds post codes to report as
        details-free stubs. When the list ends it raises as `Job.wait()` does (SignInRequired after the posts it
        could get, RateLimited, JobFailed, Cancelled); a stream that breaks raises AppNotReachable. Leaving early
        or Ctrl+C cancels the list."""
        if "posts" not in (self.info().get("features") or []):
            raise TurboDLError("Update TurboDL to 0.8.0 or newer to list posts.")
        options = {"postsOnly": True}  # type: Dict[str, Any]
        if since is not None:
            options["since"] = _iso_utc(since) if isinstance(since, datetime) else since
        if limit is not None:
            options["limit"] = limit
        if known is not None:
            options["known"] = list(known)
        job = Job(self._call("POST", "/v1/jobs", {"url": url, "options": options})["job"], self)
        seen = []  # type: List[str]
        stream = self._stream(job.id, None)
        try:
            for event in stream:
                if event.get("type") == "post" and isinstance(event.get("post"), dict):
                    yield Post.from_api(event["post"])
                    continue
                job._apply(event, seen)
                if event.get("type") == "end":
                    job._finish()
                    return
            raise AppNotReachable("Lost TurboDL while listing posts.", job)
        except (GeneratorExit, KeyboardInterrupt):
            if not job.ended:
                try:
                    self._cancel_raw(job.id)
                except TurboDLError:
                    pass
            raise
        finally:
            stream.close()

    def instagram_login(self) -> Dict[str, Any]:
        """Opens TurboDL's Instagram sign-in and waits for it: {"signed_in": bool, "username": Optional[str]}."""
        r = self._call("POST", "/v1/instagram/login", {}, timeout=None)
        return {"signed_in": bool(r.get("signedIn")), "username": r.get("username")}

    def instagram_logout(self) -> None:
        self._call("POST", "/v1/instagram/logout", {})
