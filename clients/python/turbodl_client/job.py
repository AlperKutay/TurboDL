"""A download job, as the API describes it."""

import time
from typing import Any, Callable, Dict, Generator, Iterator, List, Optional

from ._http import JobNotFound
from .errors import AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError

ENDED_STATES = ("done", "failed", "cancelled")


class Job:
    """A snapshot of one job; `refresh()` re-reads it, `wait()` follows it to its end."""

    def __init__(self, data: Dict[str, Any], client: Any = None) -> None:
        self._client = client
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
        events = self._follow(deadline)
        try:
            try:
                for event in events:
                    if on_event is not None:
                        on_event(event)
            finally:
                events.close()  # no stream is left open, whatever on_event raised
        except KeyboardInterrupt:
            self._cancel_interrupted()
            raise
        return self._finish()

    def _cancel_interrupted(self) -> None:
        """Ctrl+C: cancels the job. When the app can't be reached (the stream was cut, it may be starting again on
        another port), the cancel is sent again once api.json names a port that answers, as the command does."""
        try:
            try:
                self.cancel()
            except AppNotReachable:
                if self._client._reconnect():
                    self.cancel()
        except TurboDLError:
            pass

    def _message(self, sign_in: bool) -> Optional[str]:
        """The job's own words: its error; for a limited job the sign-in warning comes first."""
        warned = next((w for w in self.warnings if "sign" in w.lower()), None)
        if sign_in:
            return warned or self.error or (self.warnings[-1] if self.warnings else None)
        return self.error or (self.warnings[-1] if self.warnings else None)

    def _finish(self) -> "Job":
        if self.state == "done" and not self.limited:
            return self
        if self.state == "done" or (self.state == "failed" and self.reason == "signInRequired"):
            message = self._message(self.state == "done")
            raise SignInRequired(message or "Sign in to Instagram to save everything.", self.reason or "signInRequired", self)
        if self.state == "failed" and self.reason == "rateLimited":
            raise RateLimited(self._message(False) or "The site is limiting requests. Try again later.", "rateLimited", self)
        if self.state == "cancelled":
            here = self._client is not None and self.id in self._client._cancelled
            raise Cancelled(self._message(False) or "Cancelled.", None if here else "stopped", self)
        raise JobFailed(self._message(False) or "The download failed.", self.reason or "error", self)

    def _follow(self, deadline: Optional[float]) -> Generator[Dict[str, Any], None, None]:
        seen = []  # type: List[str]
        for attempt in (1, 2):
            stream = self._client._stream(self.id, deadline)
            try:
                for event in stream:
                    if not self._apply(event, seen):
                        yield event
                    if event.get("type") == "end":
                        return
            except JobNotFound:
                if attempt == 1:
                    raise
                break  # the app restarted: jobs live in its memory
            finally:
                stream.close()
            if attempt == 1 and self._client._reconnect(deadline):
                continue
            break
        raise AppNotReachable("TurboDL quit.", self)

    def _apply(self, event: Dict[str, Any], seen: List[str]) -> bool:
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
            seen.append(path)
            if path not in self.files:
                self.files.append(path)
        return False

    def __repr__(self) -> str:
        return "Job(id=%r, state=%r, reason=%r)" % (self.id, self.state, self.reason)
