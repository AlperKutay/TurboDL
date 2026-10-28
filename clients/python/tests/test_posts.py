import _thread
import gc
import time
from datetime import datetime, timedelta, timezone

from turbodl_client import AppNotReachable, Post, PostList, RateLimited, SignInRequired, TurboDLError
from tests.stub import make_job
from tests.test_jobs import JobCase, readers

URL = "https://www.instagram.com/someone/"


def post(code: str, **extra):
    d = {"code": code, "url": "https://www.instagram.com/p/%s/" % code, "takenAt": "2026-10-20T08:30:00.000Z",
         "pinned": False, "owner": "someone", "taggedUsers": [], "items": []}
    d.update(extra)
    return {"type": "post", "jobId": "j1", "post": d}


def end(state: str, **extra):
    return {"type": "end", "jobId": "j1", "job": make_job("j1", state=state, endedAt=9, **extra)}


def wait_for(test, condition, seconds: float = 3.0) -> None:
    stop = time.monotonic() + seconds
    while not condition() and time.monotonic() < stop:
        time.sleep(0.02)
    test.assertTrue(condition())


class PostsTests(JobCase):
    def serve(self, **kw):
        t = super().serve(**kw)
        self.stub.snapshot = True  # as the app does, each stream starts with the job
        return t

    def test_yields_posts_with_their_fields(self) -> None:
        t = self.serve()
        self.script({"type": "state", "jobId": "j1", "state": "running"},
                    post("AAA", caption="Hello", pinned=True, taggedUsers=["a", "b"], items=[
                        {"kind": "image", "url": "https://cdn/1.jpg", "mediaId": "m1", "width": 1080, "height": 1350},
                        {"kind": "video", "url": "https://cdn/2.mp4", "duration": 12.5}]),
                    end("done", reason="done"))
        posts = list(t.posts(URL))
        self.assertEqual(len(posts), 1)
        p = posts[0]
        self.assertIsInstance(p, Post)
        self.assertEqual((p.code, p.url, p.owner, p.caption, p.pinned, p.tagged_users),
                         ("AAA", "https://www.instagram.com/p/AAA/", "someone", "Hello", True, ["a", "b"]))
        self.assertEqual(p.taken_at, datetime(2026, 10, 20, 8, 30, tzinfo=timezone.utc))
        self.assertEqual(p.taken_at.utcoffset(), timedelta(0))
        self.assertEqual((p.sign_in_only, p.known), (False, False))
        first, second = p.items
        self.assertEqual((first.kind, first.url, first.media_id, first.width, first.height, first.duration),
                         ("image", "https://cdn/1.jpg", "m1", 1080, 1350, None))
        self.assertEqual((second.kind, second.media_id, second.width, second.duration), ("video", None, None, 12.5))

    def test_known_stub_has_no_items_and_no_time(self) -> None:
        t = self.serve()
        self.script(post("KKK", known=True, takenAt=None, owner=None), end("done", reason="done"))
        p = next(iter(t.posts(URL)))
        self.assertEqual((p.known, p.taken_at, p.owner, p.caption, p.items, p.tagged_users),
                         (True, None, None, None, [], []))

    def test_sends_postsonly_since_limit_known(self) -> None:
        t = self.serve()
        self.script(end("done", reason="done"))
        self.assertEqual(list(t.posts(URL, since=datetime(2026, 10, 1), limit=5, known=iter(["a", "b"]))), [])
        self.assertEqual(self.stub.posted[0], {"url": URL, "options": {
            "postsOnly": True, "since": "2026-10-01T00:00:00Z", "limit": 5, "known": ["a", "b"]}})

    def test_since_forms(self) -> None:
        t = self.serve()
        zone = timezone(timedelta(hours=3))
        for since, sent in ((datetime(2026, 10, 1, 12, 0, 0, 250000, tzinfo=zone), "2026-10-01T09:00:00.250000Z"),
                            ("2026-10-01", "2026-10-01")):
            self.stub.events.clear()
            self.script(end("done", reason="done"))
            list(t.posts(URL, since=since))
            self.assertEqual(self.stub.posted[-1]["options"]["since"], sent)
            self.stub.jobs.clear()

    def test_rate_limited_raises_after_the_posts_it_sent(self) -> None:
        t = self.serve()
        self.script(post("AAA"), end("failed", reason="rateLimited", error="Slow down"))
        got = []
        with self.assertRaises(RateLimited) as cm:
            for p in t.posts(URL):
                got.append(p.code)
        self.assertEqual(got, ["AAA"])
        self.assertEqual(cm.exception.job.id, "j1")

    def test_limited_raises_sign_in_required_after_all_posts(self) -> None:
        t = self.serve()
        self.script(post("AAA"), post("BBB", signInOnly=True),
                    end("done", reason="done", limited=True, warnings=["Sign in to Instagram to see more posts."]))
        got = []
        with self.assertRaises(SignInRequired) as cm:
            for p in t.posts(URL):
                got.append((p.code, p.sign_in_only))
        self.assertEqual(got, [("AAA", False), ("BBB", True)])
        self.assertEqual(cm.exception.job.state, "done")

    def test_closing_early_cancels_the_job(self) -> None:
        t = self.serve()
        self.script(post("AAA"), post("BBB"))
        posts = t.posts(URL)
        self.assertEqual(next(posts).code, "AAA")
        posts.close()
        self.assertEqual(self.stub.cancelled, ["j1"])

    def test_close_before_iterating_cancels_the_job(self) -> None:
        t = self.serve()
        posts = t.posts(URL)
        posts.close()
        self.assertEqual(self.stub.cancelled, ["j1"])
        self.assertEqual(list(posts), [])

    def test_leaving_the_loop_early_cancels_the_job(self) -> None:
        t = self.serve()
        self.script(post("AAA"), post("BBB"))
        for p in t.posts(URL):
            break
        gc.collect()
        self.assertEqual(self.stub.cancelled, ["j1"])

    def test_ctrl_c_while_waiting_for_a_post_cancels_the_list(self) -> None:
        t = self.serve()
        posts = t.posts(URL)  # then nothing arrives
        self.later(0.3, _thread.interrupt_main)
        with self.assertRaises(KeyboardInterrupt):
            next(posts)
        self.assertEqual(self.stub.cancelled, ["j1"])
        self.assertEqual(readers(), [])

    def test_the_list_keeps_its_job_up_to_date(self) -> None:
        t = self.serve()
        skipped = "1 post showed nothing and was skipped."
        self.script(post("AAA"), {"type": "warning", "jobId": "j1", "message": skipped}, post("BBB"),
                    end("done", reason="done", failedItems=1, warnings=[skipped]))
        posts = t.posts(URL)
        self.assertIsInstance(posts, PostList)
        self.assertIs(iter(posts), posts)
        self.assertEqual((posts.job.id, posts.job.state), ("j1", "queued"))
        warned = []
        for p in posts:
            warned.append((p.code, list(posts.job.warnings)))
        self.assertEqual(warned, [("AAA", []), ("BBB", [skipped])])
        self.assertEqual((posts.job.state, posts.job.failed_items, posts.job.warnings), ("done", 1, [skipped]))
        self.assertEqual(self.stub.cancelled, [])

    def test_a_stream_that_wont_open_raises_at_the_call_and_cancels_the_job(self) -> None:
        t = self.serve()
        self.stub.events_error = (500, {"error": "Busy."})
        with self.assertRaises(TurboDLError) as cm:
            t.posts(URL)
        self.assertEqual(str(cm.exception), "Busy.")
        self.assertEqual(self.stub.cancelled, ["j1"])

    def test_a_finished_list_is_not_cancelled(self) -> None:
        t = self.serve()
        self.script(post("AAA"), end("done", reason="done"))
        list(t.posts(URL))
        self.assertEqual(self.stub.cancelled, [])

    def test_broken_stream_raises_app_not_reachable_without_reconnecting(self) -> None:
        t = self.serve()
        self.script(post("AAA"), None)
        got = []
        with self.assertRaises(AppNotReachable) as cm:
            for p in t.posts(URL):
                got.append(p.code)
        self.assertEqual(got, ["AAA"])
        self.assertEqual(str(cm.exception), "Lost TurboDL while listing posts.")
        self.assertEqual(cm.exception.job.id, "j1")
        self.assertEqual(self.stub.events_requests, 1)

    def test_old_app_without_the_feature_is_told_to_update(self) -> None:
        t = self.serve()
        self.stub.features = []
        with self.assertRaises(TurboDLError) as cm:
            t.posts(URL)  # raises at the call, before any next()
        self.assertEqual(str(cm.exception), "Update TurboDL to 0.8.0 or newer to list posts.")
        self.assertEqual(self.stub.posted, [])

    def test_the_job_is_created_and_followed_when_posts_is_called(self) -> None:
        t = self.serve()
        it = t.posts(URL)
        self.assertEqual(len(self.stub.posted), 1)
        self.assertTrue(self.stub.posted[0]["options"]["postsOnly"])
        # the stream is open before any next(): the app reads nothing for a list nobody follows
        self.assertEqual(self.stub.events_requests, 1)
        self.script(post("AAA"), end("done", reason="done"))
        self.assertEqual([p.code for p in it], ["AAA"])
