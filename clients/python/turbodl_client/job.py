"""A download job, as the API describes it."""

import time
from typing import Any, Callable, Dict, Iterator, List, Optional, Set

from .errors import AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError

ENDED_STATES = ("done", "failed", "cancelled")


class Job:
    """A snapshot of one job; `refresh()` re-reads it, `wait()` follows it to its end."""

    def __init__(self, data: Dict[str, Any], client: Any = None) -> None:
        self._client = client
        self._cancelled_here = False
        self._set(data)

    def _set(self, d: Dict[str, Any]) -> None:
        self.id = d["id"]  # type: str
        self.url = d.get("url", "")  # type: str
        self.kind = d.get("kind", "")  # type: str
        self.state = d.get("state", "")  # type: str
        self.reason = d.get("reason")  # type: Optional[str]
        self.error = d.get("error")  # type: Optional[str]
        self.limited = bool(d.get("limited", False))
        self.warnings = list(d.get("warnings") or [])  # type: List[str]
        self.files = list(d.get("files") or [])  # type: List[str]
        self.failed_items = int(d.get("failedItems") or 0)
        self.progress = dict(d.get("progress") or {})  # type: Dict[str, Any]
        self.created_at = d.get("createdAt", 0)  # type: int
        self.ended_at = d.get("endedAt")  # type: Optional[int]

    @property
    def ended(self) -> bool:
        return self.state in ENDED_STATES

    def refresh(self) -> "Job":
        self._set(self._client._fetch(self.id))
        return self

    def cancel(self) -> "Job":
        self._cancelled_here = True
        self._set(self._client._cancel_raw(self.id))
        return self

    def events(self) -> Iterator[Dict[str, Any]]:
        """Every event of the job, in order, up to and including `end`; the job's fields follow along.

        A stream that closes before `end` is re-opened once (the app may have restarted); if that fails too,
        AppNotReachable("TurboDL quit.") is raised with this job attached."""
        return self._follow(None)

    def wait(self, timeout: Optional[float] = None, on_event: Optional[Callable[[Dict[str, Any]], None]] = None) -> "Job":
        """Follows the job to its end and returns it when it is done; otherwise raises how it ended.

        `timeout` (seconds) raises TimeoutError and leaves the job running; Ctrl+C cancels the job and is re-raised."""
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            for event in self._follow(deadline):
                if on_event is not None:
                    on_event(event)
        except KeyboardInterrupt:
            self._cancelled_here = True
            try:
                self.cancel()
            except TurboDLError:
                pass
            raise
        return self._finish()

    def _finish(self) -> "Job":
        message = self.error or (self.warnings[0] if self.warnings else None)
        if self.state == "done" and not self.limited:
            return self
        if self.state == "done" or (self.state == "failed" and self.reason == "signInRequired"):
            raise SignInRequired(message or "Sign in to Instagram to save everything.", self.reason or "signInRequired", self)
        if self.state == "failed" and self.reason == "rateLimited":
            raise RateLimited(message or "The site is limiting requests. Try again later.", "rateLimited", self)
        if self.state == "cancelled":
            raise Cancelled(message or "Cancelled.", None if self._cancelled_here else "stopped", self)
        raise JobFailed(message or "The download failed.", self.reason or "error", self)

    def _follow(self, deadline: Optional[float]) -> Iterator[Dict[str, Any]]:
        seen = set()  # type: Set[str]
        for attempt in (1, 2):
            try:
                for event in self._client._stream(self.id, deadline):
                    skip = self._apply(event, seen)
                    if not skip:
                        yield event
                    if event.get("type") == "end":
                        return
            except AppNotReachable:
                pass
            if attempt == 1 and self._client._reconnect():
                continue
            break
        raise AppNotReachable("TurboDL quit.", self)

    def _apply(self, event: Dict[str, Any], seen: Set[str]) -> bool:
        """Folds an event into the job; True for a `file` event already seen (a replay)."""
        kind = event.get("type")
        job = event.get("job")
        if kind in ("job", "end") and isinstance(job, dict):
            self._set(job)
            if kind == "job":
                self.files += [p for p in seen if p not in self.files]
        elif kind == "state" and isinstance(event.get("state"), str):
            self.state = event["state"]
        elif kind == "progress" and isinstance(event.get("progress"), dict):
            self.progress = dict(event["progress"])
        elif kind == "warning" and isinstance(event.get("message"), str):
            self.warnings.append(event["message"])
        elif kind == "file" and isinstance(event.get("path"), str):
            path = event["path"]
            if path in seen:
                return True
            seen.add(path)
            if path not in self.files:
                self.files.append(path)
        return False

    def __repr__(self) -> str:
        return "Job(id=%r, state=%r, reason=%r)" % (self.id, self.state, self.reason)
