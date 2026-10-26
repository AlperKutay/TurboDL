"""One request to the local API."""

import http.client
import json
from typing import Any, Dict, Optional, Tuple

from .errors import AppNotReachable, TurboDLError

LOST = "Lost the connection to TurboDL."
REFUSED = "TurboDL refused the key in api.json."


def raw_request(port: int, token: str, method: str, path: str, body: Optional[Dict[str, Any]] = None,
                timeout: Optional[float] = 60.0) -> Tuple[int, Any]:
    """(status, parsed JSON) for one call; a refused or reset connection is AppNotReachable."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        headers = {"Authorization": "Bearer " + token}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        res = conn.getresponse()
        text = res.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        return res.status, parsed
    except (OSError, http.client.HTTPException):
        raise AppNotReachable(LOST) from None
    finally:
        conn.close()


def request(port: int, token: str, method: str, path: str, body: Optional[Dict[str, Any]] = None,
            timeout: Optional[float] = 60.0, not_found: Optional[str] = None) -> Any:
    """The parsed JSON of a successful call; 400, 403 (and 404 when `not_found` is given) become TurboDLError."""
    status, parsed = raw_request(port, token, method, path, body, timeout)
    if status == 404 and not_found:
        raise TurboDLError(not_found)
    if status == 403:
        raise TurboDLError(REFUSED)
    if status >= 400:
        message = parsed.get("error") if isinstance(parsed, dict) else None
        raise TurboDLError(message if isinstance(message, str) and message else "TurboDL answered %d." % status)
    return parsed
