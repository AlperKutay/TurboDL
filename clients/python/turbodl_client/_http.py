"""One request to the local API."""

import http.client
import json
import queue
import socket
import threading
import time
from typing import Any, Dict, Generator, Optional, Tuple

from .errors import AppNotReachable, TurboDLError

_TIMEOUTS = (socket.timeout, TimeoutError)


class JobNotFound(TurboDLError):
    """The app doesn't know the job."""


LOST = "Lost the connection to TurboDL."
REFUSED = "TurboDL refused the key in api.json."
# How long a wait for the next event lasts before it looks again at the deadline and a pending Ctrl+C.
POLL = 0.5
_END = object()  # the reader's last item: the stream closed or broke


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
                 not_found: Optional[str] = None) -> Generator[Dict[str, Any], None, None]:
    """The JSON objects of an NDJSON response, as they arrive.

    Returns when the server closes the stream (or the connection breaks); raises the builtin TimeoutError at
    `deadline` (a time.monotonic() value) and TurboDLError for a refused or failed call. A thread reads the
    stream, so a Ctrl+C is seen within POLL seconds even when nothing arrives (Windows doesn't interrupt a read)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=_remaining(deadline))
    res = None
    reader = None
    try:
        try:
            conn.request("GET", path, headers={"Authorization": "Bearer " + token})
            sock = conn.sock  # kept: the response may drop conn.sock (HTTP/1.0 or Connection: close)
            res = conn.getresponse()
        except _TIMEOUTS:
            raise TimeoutError() from None
        except (OSError, http.client.HTTPException):
            return
        if res.status != 200:
            res.read()
            if res.status == 404 and not_found:
                raise JobNotFound(not_found)
            if res.status == 403:
                raise TurboDLError(REFUSED)
            raise TurboDLError("TurboDL answered %d." % res.status)
        sock.settimeout(None)  # the reader waits as long as the app is silent; the deadline is kept below
        events = queue.Queue()  # type: queue.Queue
        reader = threading.Thread(target=_read, args=(conn, res, events), name="turbodl-events", daemon=True)
        reader.start()
        while True:
            left = _remaining(deadline)
            try:
                event = events.get(timeout=POLL if left is None else min(POLL, left))
            except queue.Empty:
                continue
            if event is _END:
                return
            yield event
    finally:
        if reader is None:
            if res is not None:
                res.close()
            conn.close()
        else:
            _stop(sock)
            reader.join(1.0)


def _read(conn: http.client.HTTPConnection, res: http.client.HTTPResponse, events: "queue.Queue") -> None:
    """The reader thread: each JSON object of the stream onto `events`, then _END; it alone closes the response."""
    try:
        while True:
            line = res.readline()
            if not line:
                break
            try:
                value = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(value, dict):
                events.put(value)
    except (OSError, ValueError, http.client.HTTPException):
        pass  # a cut, or _stop() closed the socket under it
    finally:
        try:
            res.close()
            conn.close()
        except OSError:
            pass
        finally:
            events.put(_END)


def _stop(sock: socket.socket) -> None:
    """Ends a read blocked on `sock` at once: shutdown wakes it on POSIX, the close on Windows.

    The handle is detached and closed as such: sock.close() waits for the response's file to let go of it, and
    the file's own close would block behind the read."""
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    fd = sock.detach()  # -1 once the reader closed it: only one side ever closes the handle
    if fd != -1:
        try:
            socket.close(fd)
        except OSError:
            pass


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
