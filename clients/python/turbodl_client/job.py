"""A download job, as the API describes it."""

from typing import Any, Dict, List, Optional


class Job:
    """A snapshot of one job; `refresh()` re-reads it."""

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
        return self.state == "ended"

    def refresh(self) -> "Job":
        self._set(self._client._fetch(self.id))
        return self

    def cancel(self) -> "Job":
        self._set(self._client._cancel_raw(self.id))
        return self

    def __repr__(self) -> str:
        return "Job(id=%r, state=%r, reason=%r)" % (self.id, self.state, self.reason)
