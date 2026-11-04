"""turbodl-client: queue links in the TurboDL download manager from Python."""

from .client import TurboDL
from .errors import AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError
from .job import Job
from .lists import ProfileListRun, read_profile_list
from .posts import Post, PostItem, PostList

__version__ = "0.4.0"

__all__ = ["TurboDL", "Job", "Post", "PostItem", "PostList", "ProfileListRun", "read_profile_list", "TurboDLError",
           "AppNotReachable", "JobFailed", "SignInRequired", "RateLimited", "Cancelled", "__version__"]
