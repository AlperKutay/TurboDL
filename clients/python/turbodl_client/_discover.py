"""Finds the running TurboDL, or starts it, through api.json."""

import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, Optional, Tuple

from ._http import raw_request
from .errors import AppNotReachable

API_FILE = "api.json"
NEVER_OPENED = "TurboDL hasn't been opened on this computer yet. Open it once, then try again."
PORT_FALLBACK = "TurboDL couldn't open its local port. Pick another port in TurboDL's Settings."
POLL = 0.25
# How long a file that says `port: null` gets to change after the start before its message is raised.
PORT_GRACE = 5.0


def user_data_dir(user_data: Optional[str] = None) -> str:
    """The argument, TURBODL_USER_DATA, else %APPDATA%\\TurboDL, ~/Library/Application Support/TurboDL or ~/.config/TurboDL."""
    if user_data:
        return user_data
    env = os.environ.get("TURBODL_USER_DATA")
    if env:
        return env
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"), "TurboDL")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "TurboDL")
    return os.path.join(home, ".config", "TurboDL")


def read_api_file(folder: str) -> Optional[Dict[str, Any]]:
    """The parsed api.json in `folder`, or None when it is missing or unreadable."""
    try:
        with open(os.path.join(folder, API_FILE), encoding="utf-8") as f:
            v = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(v, dict) and isinstance(v.get("token"), str) and isinstance(v.get("launch"), dict):
        return v
    return None


def _ping(port: int, token: str) -> bool:
    """True when something answers on the port (a wrong key is reported later, by the first call)."""
    try:
        raw_request(port, token, "GET", "/v1/info", timeout=2.0)
        return True
    except AppNotReachable:
        return False


def _spawn(launch: Dict[str, Any]) -> None:
    """Starts the app detached from this process: no stdio, without ELECTRON_RUN_AS_NODE."""
    env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
    kwargs = {}  # type: Dict[str, Any]
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([launch["file"]] + list(launch.get("args") or []), env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    except (OSError, ValueError, KeyError):
        pass  # the wait below reports that the app didn't start


def connect(folder: str, start: bool, timeout: float) -> Tuple[int, str]:
    """(port, token) of the running app, or of the app started from api.json's `launch`; else AppNotReachable."""
    file = read_api_file(folder)
    if file is None:
        raise AppNotReachable(NEVER_OPENED)
    if file.get("port") is not None and _ping(file["port"], file["token"]):
        return file["port"], file["token"]
    if not start:
        if file.get("port") is None:
            raise AppNotReachable(file.get("error") or PORT_FALLBACK)
        raise AppNotReachable("TurboDL isn't running.")

    _spawn(file["launch"])
    began = time.monotonic()
    port_error = None  # type: Optional[str]
    while time.monotonic() - began < timeout:
        time.sleep(POLL)
        file = read_api_file(folder) or file
        if file.get("port") is None:
            port_error = file.get("error") or PORT_FALLBACK
            if time.monotonic() - began >= PORT_GRACE:
                raise AppNotReachable(port_error)
            continue
        port_error = None
        if _ping(file["port"], file["token"]):
            return file["port"], file["token"]
    raise AppNotReachable(port_error or "TurboDL didn't start within %g seconds." % timeout)
