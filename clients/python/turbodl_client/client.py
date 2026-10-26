"""The TurboDL client: finds the app, starts it when needed, and talks to its local API."""

import os
import time
from typing import Any, Callable, Dict, Iterator, List, Optional

from . import _discover
from ._http import request, stream_lines
from .errors import TurboDLError
from .job import Job

API_VERSION = 1
# When an events stream closes without `end`, how long the app gets to answer again before it counts as quit.
RECONNECT_WINDOW = 5.0
RECONNECT_POLL = 0.25


class TurboDL:
    """A connection to the running TurboDL; starts the app when it isn't running (unless `start=False`)."""

    def __init__(self, user_data: Optional[str] = None, start: bool = True, timeout: float = 30.0) -> None:
        self._folder = _discover.user_data_dir(user_data)
        self._start = start
        self._timeout = timeout
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
        return self._job_call("POST", "/v1/jobs/" + id + "/cancel", id)

    def _job_call(self, method: str, path: str, id: str) -> Dict[str, Any]:
        return request(self._port, self._token, method, path, not_found="No job %s." % id)["job"]

    def _stream(self, id: str, deadline: Optional[float]) -> Iterator[Dict[str, Any]]:
        return stream_lines(self._port, self._token, "/v1/jobs/" + id + "/events", deadline, "No job %s." % id)

    def _reconnect(self) -> bool:
        """Looks api.json up again (the app may have restarted on another port) for up to RECONNECT_WINDOW seconds."""
        began = time.monotonic()
        while True:
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

    def instagram_login(self) -> Dict[str, Any]:
        """Opens TurboDL's Instagram sign-in and waits for it: {"signed_in": bool, "username": Optional[str]}."""
        r = self._call("POST", "/v1/instagram/login", {}, timeout=None)
        return {"signed_in": bool(r.get("signedIn")), "username": r.get("username")}

    def instagram_logout(self) -> None:
        self._call("POST", "/v1/instagram/logout", {})
