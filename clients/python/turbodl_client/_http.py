"""One request to the local API."""

import http.client
import json
import socket
import time
from typing import Any, Dict, Iterator, Optional, Tuple

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


def stream_lines(port: int, token: str, path: str, deadline: Optional[float] = None,
                 not_found: Optional[str] = None) -> Iterator[Dict[str, Any]]:
    """The JSON objects of an NDJSON response, as they arrive.

    Returns when the server closes the stream (or the connection breaks); raises the builtin TimeoutError at
    `deadline` (a time.monotonic() value) and TurboDLError for a refused or failed call."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=_remaining(deadline))
    try:
        try:
            conn.request("GET", path, headers={"Authorization": "Bearer " + token})
            res = conn.getresponse()
        except socket.timeout:
            raise TimeoutError() from None
        except (OSError, http.client.HTTPException):
            return
        if res.status != 200:
            res.read()
            if res.status == 404 and not_found:
                raise TurboDLError(not_found)
            if res.status == 403:
                raise TurboDLError(REFUSED)
            raise TurboDLError("TurboDL answered %d." % res.status)
        while True:
            try:
                if deadline is not None and conn.sock is not None:
                    conn.sock.settimeout(_remaining(deadline))
                line = res.readline()
            except socket.timeout:
                raise TimeoutError() from None
            except (OSError, http.client.HTTPException):
                return
            if not line:
                return
            try:
                value = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(value, dict):
                yield value
    finally:
        conn.close()


def _remaining(deadline: Optional[float]) -> Optional[float]:
    if deadline is None:
        return None
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError()
    return left


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
