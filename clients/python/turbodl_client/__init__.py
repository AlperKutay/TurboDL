"""turbodl-client: queue links in the TurboDL download manager from Python."""

from .client import TurboDL
from .errors import AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError
from .job import Job
from .posts import Post, PostItem

__version__ = "0.2.0"

__all__ = ["TurboDL", "Job", "Post", "PostItem", "TurboDLError", "AppNotReachable", "JobFailed", "SignInRequired",
           "RateLimited", "Cancelled", "__version__"]
