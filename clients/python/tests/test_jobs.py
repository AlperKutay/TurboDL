import _thread
import os
import threading
import time
import unittest
from unittest import mock

from turbodl_client import (AppNotReachable, Cancelled, JobFailed, RateLimited, SignInRequired, TurboDLError)
from turbodl_client import client as client_module
from tests.stub import StubApi, make_job, write_api_file
from tests.test_client import ClientCase

URL = "https://example.com/a"
FILE = os.path.join("C:\\", "Downloads", "Fotoğraf-é.jpg")
FILE2 = os.path.join("C:\\", "Downloads", "b.jpg")


def ended(**extra):
    return make_job("j1", state="done", reason="done", files=[FILE], endedAt=9, **extra)


def readers():
    """The threads still reading an events stream."""
    return [t for t in threading.enumerate() if t.name == "turbodl-events" and t.is_alive()]


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

    def later(self, seconds: float, fn) -> None:
        """Runs `fn` on a timer thread, cancelled when the test ends."""
        timer = threading.Timer(seconds, fn)
        timer.daemon = True
        self.addCleanup(timer.cancel)
        timer.start()


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
        self.script({"type": "end", "jobId": "j1", "job": ended(limited=True, warnings=["The folder and name are ignored.", "Sign in to Instagram to save everything."])})
        with self.assertRaises(SignInRequired) as cm:
            t.get(URL)
        self.assertEqual(str(cm.exception), "Sign in to Instagram to save everything.")
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

    def test_cancelled_through_the_client_has_no_reason(self) -> None:
        t = self.serve()
        job = t.add(URL)
        t.cancel(job.id)
        self.script({"type": "end", "jobId": "j1", "job": make_job("j1", state="cancelled")})
        with self.assertRaises(Cancelled) as cm:
            job.wait()
        self.assertIsNone(cm.exception.reason)

    def test_cancel_then_wait_on_the_returned_job(self) -> None:
        t = self.serve()
        t.add(URL)
        self.script({"type": "end", "jobId": "j1", "job": make_job("j1", state="cancelled")})
        with self.assertRaises(Cancelled) as cm:
            t.cancel("j1").wait()
        self.assertIsNone(cm.exception.reason)

    def test_unknown_job(self) -> None:
        t = self.serve()
        job = t.add(URL)
        del self.stub.jobs["j1"]
        with self.assertRaises(TurboDLError) as cm:
            list(job.events())
        self.assertEqual(str(cm.exception), "No job j1.")

    def test_a_refused_stream_gives_the_apps_message(self) -> None:
        t = self.serve()
        job = t.add(URL)
        for reply, message in (((503, {"error": "TurboDL is closing."}), "TurboDL is closing."),
                               ((500, {}), "TurboDL answered 500."),
                               ((403, {"error": "Forbidden"}), "TurboDL refused the key in api.json.")):
            self.stub.events_error = reply
            with self.assertRaises(TurboDLError) as cm:
                list(job.events())
            self.assertEqual(str(cm.exception), message)

    def test_leaving_events_early_closes_the_stream(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})
        for _event in job.events():
            break
        self.assertEqual(readers(), [])


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

    def test_a_restarted_app_that_forgot_the_job_is_quit(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")},
                    {"type": "file", "jobId": "j1", "path": FILE}, None)

        def forget(event) -> None:
            if event["type"] == "file":
                del self.stub.jobs["j1"]  # a restart keeps no jobs: the re-subscribe is a 404

        with self.assertRaises(AppNotReachable) as cm:
            job.wait(on_event=forget)
        self.assertEqual((str(cm.exception), cm.exception.job.id, cm.exception.job.files), ("TurboDL quit.", "j1", [FILE]))

    def test_files_keep_their_order_over_a_replay(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "file", "jobId": "j1", "path": FILE2}, {"type": "file", "jobId": "j1", "path": FILE}, None,
                    {"type": "job", "jobId": "j1", "job": make_job("j1", state="running")},
                    {"type": "end", "jobId": "j1", "job": make_job("j1", state="done", files=[FILE2, FILE])})
        list(job.events())
        self.assertEqual(job.files, [FILE2, FILE])

    def test_the_deadline_holds_while_events_keep_arriving(self) -> None:
        t = self.serve()
        job = t.add(URL)
        stop = threading.Event()

        def feed() -> None:
            while not stop.is_set():
                self.stub.push("j1", {"type": "progress", "jobId": "j1", "progress": {"done": 1}})
                time.sleep(0.02)

        feeder = threading.Thread(target=feed, daemon=True)
        feeder.start()
        began = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                job.wait(timeout=0.3)
        finally:
            stop.set()
            feeder.join(2)
        self.assertLess(time.monotonic() - began, 2)

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

    def ctrl_c_while_silent(self, wait) -> None:
        """Ctrl+C while the app sends nothing (a queued job, a stall): `wait()` cancels the job at once."""
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})  # then nothing
        fired = []

        def ctrl_c() -> None:
            fired.append(time.monotonic())
            _thread.interrupt_main()

        self.later(0.3, ctrl_c)
        # an event long after: a client stuck in the read only sees the Ctrl+C then
        self.later(4.0, lambda: self.stub.push("j1", {"type": "progress", "jobId": "j1", "progress": {"done": 1}}))
        with self.assertRaises(KeyboardInterrupt):
            wait()
        self.assertLess(time.monotonic() - fired[0], 1.5)
        self.assertEqual(self.stub.cancelled, ["j1"])
        self.assertEqual(readers(), [])

    def test_ctrl_c_in_get_while_nothing_arrives(self) -> None:
        t = self.serve()
        self.ctrl_c_while_silent(lambda: t.get(URL))

    def test_ctrl_c_in_wait_with_a_timeout_while_nothing_arrives(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.ctrl_c_while_silent(lambda: job.wait(timeout=60))

    def test_a_ctrl_c_while_the_stream_is_cut_reaches_the_restarted_app(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")}, None)
        old = self.stub
        back = StubApi()  # the app once it answers again, on another port
        back.jobs["j1"] = make_job("j1", state="running")
        self.addCleanup(lambda: back.stop() if back.started else None)

        def come_back() -> None:
            if not back.started:
                back.start()
                write_api_file(self.tmp, back.port)

        def restart(event) -> None:
            if event["type"] == "job":
                old.gone = come_back  # the old port answers no more; the cancel sent there brings the app back
                write_api_file(self.tmp, None)  # starting again: no port yet
                self.later(0.1, _thread.interrupt_main)  # pressed while the client waits for the app

        with mock.patch.object(client_module, "RECONNECT_WINDOW", 5.0), self.assertRaises(KeyboardInterrupt):
            job.wait(on_event=restart)
        self.assertEqual((old.cancelled, back.cancelled), ([], ["j1"]))

    def test_an_error_in_on_event_closes_the_stream(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})

        def boom(_event) -> None:
            raise RuntimeError("boom")

        try:
            job.wait(on_event=boom)
        except RuntimeError:
            self.assertEqual(readers(), [])  # checked while the traceback still holds wait()'s frame
        else:
            self.fail("on_event's error was swallowed")

    def test_wait_timeout_leaves_the_job_running(self) -> None:
        t = self.serve()
        job = t.add(URL)
        self.script({"type": "job", "jobId": "j1", "job": make_job("j1", state="running")})
        with self.assertRaises(TimeoutError):
            job.wait(timeout=0.3)
        self.assertEqual(self.stub.cancelled, [])
        self.assertEqual(job.state, "running")
        self.assertEqual(readers(), [])


if __name__ == "__main__":
    unittest.main()
