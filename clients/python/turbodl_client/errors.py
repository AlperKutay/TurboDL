"""The errors turbodl-client raises."""

from typing import Optional


class TurboDLError(Exception):
    """Anything TurboDL or this client refuses; `.job` is the job concerned, when there is one."""

    def __init__(self, message: str, job: "Optional[object]" = None) -> None:
        super().__init__(message)
        self.job = job


class AppNotReachable(TurboDLError):
    """TurboDL isn't running, couldn't be started, or went away."""


class JobFailed(TurboDLError):
    """The job ended without producing what was asked; `.reason` is the API's reason."""

    def __init__(self, message: str, reason: str = "failed", job: "Optional[object]" = None) -> None:
        super().__init__(message, job)
        self.reason = reason


class SignInRequired(JobFailed):
    """The link needs the Instagram sign-in."""


class RateLimited(JobFailed):
    """The site is limiting requests; try again later."""


class Cancelled(TurboDLError):
    """The job was cancelled; `.reason` is "stopped", or None when this process cancelled it."""

    def __init__(self, message: str = "Cancelled.", reason: Optional[str] = None, job: "Optional[object]" = None) -> None:
        super().__init__(message, job)
        self.reason = reason


__all__ = ["TurboDLError", "AppNotReachable", "JobFailed", "SignInRequired", "RateLimited", "Cancelled"]
