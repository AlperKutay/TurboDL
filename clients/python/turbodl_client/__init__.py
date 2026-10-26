"""turbodl-client: queue links in the TurboDL download manager from Python."""

from .client import TurboDL
from .errors import AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError
from .job import Job

__version__ = "0.1.0"

__all__ = ["TurboDL", "Job", "TurboDLError", "AppNotReachable", "JobFailed", "SignInRequired", "RateLimited",
           "Cancelled", "__version__"]
