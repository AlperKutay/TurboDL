import os
import unittest
from unittest import mock

from turbodl_client import (AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError)
from turbodl_client import client as client_module
from tests.stub import make_job
from tests.test_client import ClientCase

URL = "https://example.com/a"
FILE = os.path.join("C:\\", "Downloads", "Fotoğraf-é.jpg")
FILE2 = os.path.join("C:\\", "Downloads", "b.jpg")


def ended(**extra):
    return make_job("j1", state="done", reason="done", files=[FILE], endedAt=9, **extra)


class JobCase(ClientCase):
    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch.multiple(client_module, RECONNECT_WINDOW=0.4, RECONNECT_POLL=0.05)
        patcher.start()
        self.addCleanup(patcher.stop)

    def script(self, *events) -> None:
        """Queues the stub's events for job j1 (the first job it creates)."""
        for ev in events:
            self.stub.push("j1", ev)


class FollowTests(JobCase):
    def test_get_returns_the_job_with_its_files(self) -> None:
        t = self.serve()
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")},
                    {"type": "file", "jobId": "j1", "path": FILE},
                    {"type": "end", "jobId": "j1", "job": ended()})
        seen = []
        job = t.get(URL, on_event=seen.append)
        self.assertEqual((job.state, job.files, job.ended), ("done", [FILE], True))
        self.assertEqual([e["type"] for e in seen], ["job", "file", "end"])

    def test_events_yield_every_event_and_end_after_end(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="queued")},
                    {"type": "state", "jobId": "j1", "state": "running"},
                    {"type": "progress", "jobId": "j1", "progress": {"done": 1, "total": 4}},
                    {"type": "warning", "jobId": "j1", "message": "careful"},
                    {"type": "file", "jobId": "j1", "path": FILE},
                    {"type": "end", "jobId": "j1", "job": ended()},
                    {"type": "state", "jobId": "j1", "state": "never read"})
        types = []
        for e in job.events():
            types.append(e["type"])
            if e["type"] == "progress":
                self.assertEqual((job.state, job.progress), ("running", {"done": 1, "total": 4}))
            if e["type"] == "warning":
                self.assertEqual(job.warnings, ["careful"])
            if e["type"] == "file":
                self.assertEqual(job.files, [FILE])
        self.assertEqual(types, ["job", "state", "progress", "warning", "file", "end"])
        self.assertEqual(job.state, "done")

    def test_limited_raises_sign_in_required_with_the_files_saved(self) -> None:
        t = self.serve()
        self.script({"type": "end", "jobId": "j1", "job": ended(limited=True, warnings=["Only the first 12 posts."])})
        with self.assertRaises(SignInRequired) as cm:
            t.get(URL)
        self.assertEqual(str(cm.exception), "Only the first 12 posts.")
        self.assertEqual(cm.exception.job.files, [FILE])
        self.assertIsInstance(cm.exception, JobFailed)

    def test_failed_sign_in_required(self) -> None:
        t = self.serve()
        self.script({"type": "end", "jobId": "j1", "job": make_job(
            "j1", state="failed", reason="signInRequired", error="Sign in to Instagram first.")})
        with self.assertRaises(SignInRequired) as cm:
            t.get(URL)
        self.assertEqual((str(cm.exception), cm.exception.reason), ("Sign in to Instagram first.", "signInRequired"))

    def test_rate_limited(self) -> None:
        t = self.serve()
        self.script({"type": "end", "jobId": "j1", "job": make_job(
            "j1", state="failed", reason="rateLimited", error="Instagram is slowing us down.")})
        with self.assertRaises(RateLimited) as cm:
            t.get(URL)
        self.assertEqual((str(cm.exception), cm.exception.job.id), ("Instagram is slowing us down.", "j1"))

    def test_failed_carries_its_reason(self) -> None:
        t = self.serve()
        self.script({"type": "end", "jobId": "j1", "job": make_job(
            "j1", state="failed", reason="notFound", error="That post is gone.", files=[FILE2])})
        with self.assertRaises(JobFailed) as cm:
            t.get(URL)
        e = cm.exception
        self.assertNotIsInstance(e, (SignInRequired, RateLimited))
        self.assertEqual((str(e), e.reason, e.job.files), ("That post is gone.", "notFound", [FILE2]))

    def test_cancelled_here_has_no_reason(self) -> None:
        t = self.serve()
        job = t.add(URL)
        job.cancel()
        self.script({"type": "end", "jobId": "j1", "job": make_job("j1", state="cancelled", reason="stopped")})
        with self.assertRaises(Cancelled) as cm:
            job.wait()
        self.assertIsNone(cm.exception.reason)
        self.assertIs(cm.exception.job, job)

    def test_stopped_elsewhere_has_reason_stopped(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "end", "jobId": "j1", "job": make_job("j1", state="cancelled", reason="stopped")})
        with self.assertRaises(Cancelled) as cm:
            job.wait()
        self.assertEqual(cm.exception.reason, "stopped")

    def test_unknown_job(self) -> None:
        t = self.serve()
        job = t.add(URL)
        del self.stub.jobs["j1"]
        with self.assertRaises(TurboDLError) as cm:
            list(job.events())
        self.assertEqual(str(cm.exception), "No job j1.")


class InterruptionTests(JobCase):
    def test_app_quitting_raises_app_not_reachable_with_the_job(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")},
                    {"type": "file", "jobId": "j1", "path": FILE}, None)

        def quit_app(event) -> None:
            if event["type"] == "file" and self.stub:  # the stream is cut right after this, and nothing answers again
                self.stub.stop()
                self.stub = None

        with self.assertRaises(AppNotReachable) as cm:
            job.wait(on_event=quit_app)
        self.assertEqual(str(cm.exception), "TurboDL quit.")
        self.assertEqual((cm.exception.job.id, cm.exception.job.files), ("j1", [FILE]))

    def test_a_cut_stream_is_resubscribed_once_without_repeating_files(self) -> None:
        t = self.serve()
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")},
                    {"type": "file", "jobId": "j1", "path": FILE}, None,
                    {"type": "job", "jobId": "j1", "job": make_job("j1", state="running", files=[FILE])},
                    {"type": "file", "jobId": "j1", "path": FILE},
                    {"type": "file", "jobId": "j1", "path": FILE2},
                    {"type": "end", "jobId": "j1", "job": make_job("j1", state="done", files=[FILE, FILE2])})
        seen = []
        job = t.get(URL, on_event=seen.append)
        self.assertEqual([e["path"] for e in seen if e["type"] == "file"], [FILE, FILE2])
        self.assertEqual((job.state, job.files), ("done", [FILE, FILE2]))

    def test_a_second_cut_gives_up(self) -> None:
        t = self.serve()
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")}, None,
                    {"type": "job", "jobId": "j1", "job": make_job("j1", state="running")}, None)
        with self.assertRaises(AppNotReachable) as cm:
            t.get(URL)
        self.assertEqual((str(cm.exception), cm.exception.job.id), ("TurboDL quit.", "j1"))

    def test_keyboard_interrupt_cancels_then_reraises(self) -> None:
        t = self.serve()
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})

        def interrupt(_event) -> None:
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            t.get(URL, on_event=interrupt)
        self.assertEqual(self.stub.cancelled, ["j1"])
        self.assertEqual(self.stub.jobs["j1"]["state"], "cancelled")

    def test_wait_timeout_leaves_the_job_running(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})
        with self.assertRaises(TimeoutError):
            job.wait(timeout=0.3)
        self.assertEqual(self.stub.cancelled, [])
        self.assertEqual(job.state, "running")


if __name__ == "__main__":
    unittest.main()
