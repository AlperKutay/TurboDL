"""A stand-in for TurboDL's local API, on a free port, for the tests."""

import json
import os
import queue
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def make_job(id: str = "j1", url: str = "https://example.com/a", **extra: Any) -> Dict[str, Any]:
    job = {
        "id": id, "url": url, "kind": "http", "state": "queued", "warnings": [], "files": [],
        "failedItems": 0, "progress": {}, "createdAt": 1,
    }
    job.update(extra)
    return job


def write_api_file(folder: str, port: Optional[int], token: str = "tok", api: int = 1,
                   launch: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> None:
    data = {
        "api": api, "version": "9.9.9", "port": port, "token": token,
        "launch": launch or {"file": "unused", "args": []},
    }  # type: Dict[str, Any]
    if error is not None:
        data["error"] = error
    with open(os.path.join(folder, "api.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        if not isinstance(sys.exc_info()[1], OSError):  # a client that hung up is not an error here
            super().handle_error(request, client_address)


class StubApi:
    def __init__(self, token: str = "tok", port: int = 0, api: int = 1) -> None:
        self.token = token
        self.api = api
        self.jobs = {}  # type: Dict[str, Dict[str, Any]]
        self.posted = []  # type: List[Dict[str, Any]]
        self.cancelled = []  # type: List[str]
        self.events = {}  # type: Dict[str, queue.Queue]
        self.instagram = {"signedIn": True, "username": "alper"}
        self.fail_add = None  # type: Optional[str]
        # (status, body) for /events instead of the stream
        self.events_error = None  # type: Optional[Tuple[int, Dict[str, Any]]]
        # set: the app is on its way out; every request calls it, then is dropped unanswered
        self.gone = None  # type: Optional[Callable[[], None]]
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def send(self, status: int, body: Any) -> None:
                raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def route(self, post: bool) -> None:
                if stub.gone is not None:
                    stub.gone()
                    self.close_connection = True
                    return
                if self.headers.get("Authorization") != "Bearer " + stub.token:
                    return self.send(403, {"error": "Forbidden"})
                path = self.path
                body = {}  # type: Dict[str, Any]
                if post:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                if path == "/v1/info" and not post:
                    return self.send(200, {"app": "TurboDL", "version": "9.9.9", "api": stub.api,
                                           "instagram": {"signedIn": False}})
                if path == "/v1/jobs" and post:
                    stub.posted.append(body)
                    if stub.fail_add:
                        return self.send(400, {"error": stub.fail_add})
                    job = make_job("j%d" % (len(stub.jobs) + 1), body["url"])
                    stub.jobs[job["id"]] = job
                    return self.send(201, {"job": job})
                if path == "/v1/jobs" and not post:
                    return self.send(200, {"jobs": list(stub.jobs.values())})
                if path == "/v1/instagram/login" and post:
                    return self.send(200, stub.instagram)
                if path == "/v1/instagram/logout" and post:
                    return self.send(200, {"signedIn": False})
                parts = path.split("/")
                if len(parts) >= 4 and parts[:3] == ["", "v1", "jobs"]:
                    job = stub.jobs.get(parts[3])
                    if job is None:
                        return self.send(404, {"error": "No job " + parts[3] + "."})
                    if len(parts) == 4 and not post:
                        return self.send(200, {"job": job})
                    if len(parts) == 5 and parts[4] == "cancel" and post:
                        stub.cancelled.append(job["id"])
                        job["state"] = "cancelled"
                        return self.send(200, {"job": job})
                    if len(parts) == 5 and parts[4] == "events" and not post:
                        if stub.events_error is not None:
                            return self.send(*stub.events_error)
                        q = stub.events.setdefault(job["id"], queue.Queue())
                        self.send_response(200)
                        self.send_header("Content-Type", "application/x-ndjson")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.end_headers()
                        while True:
                            ev = q.get()
                            if ev is None:
                                self.wfile.write(b"0\r\n\r\n")
                                self.wfile.flush()
                                self.close_connection = True
                                return
                            data = (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
                            self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                            self.wfile.flush()
                self.send(404, {"error": "Not found"})

            def do_GET(self) -> None:
                self.route(False)

            def do_POST(self) -> None:
                self.route(True)

        self.server = _Server(("127.0.0.1", port), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)

    def start(self) -> "StubApi":
        self.thread.start()
        return self

    @property
    def started(self) -> bool:
        return self.thread.ident is not None

    def push(self, id: str, event: Optional[Dict[str, Any]]) -> None:
        """Queue one NDJSON line for /events; None closes the stream."""
        self.events.setdefault(id, queue.Queue()).put(event)

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
