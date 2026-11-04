import _thread
import os
import time
import unittest

from turbodl_client import ProfileListRun, TurboDLError, read_profile_list
from tests.test_jobs import JobCase

OLD_APP = "Update TurboDL to 0.9.0 or newer to back up a list of profiles."


class ReadProfileListTests(JobCase):
    def read(self, data) -> list:
        """read_profile_list() of a file holding `data` (text is written as UTF-8, exactly as given)."""
        path = os.path.join(self.tmp, "list.txt")
        with open(path, "wb") as f:
            f.write(data.encode("utf-8") if isinstance(data, str) else data)
        return read_profile_list(path)

    def test_reads_every_way_a_profile_can_be_written(self) -> None:
        text = ("﻿nasa\r\n@NatGeo\r\n\r\n# a comment\r\nhttps://www.instagram.com/iremyigtt/?igsh=x\r\n"
                "https://instagram.com/natgeo/reels/\r\nNASA\r\n")
        self.assertEqual(self.read(text), ["nasa", "natgeo", "iremyigtt"])

    def test_names_the_lines_it_cannot_read(self) -> None:
        with self.assertRaises(ValueError) as cm:
            self.read("ok\nnot a name!\nhttps://www.instagram.com/p/C1/\n")
        self.assertEqual(str(cm.exception), "Line 2 isn't a profile: not a name!; "
                                            "Line 3 isn't a profile: https://www.instagram.com/p/C1/")

    def test_splits_on_a_lone_cr_and_skips_indented_comments(self) -> None:
        self.assertEqual(self.read("a\rb\n   # c\n  d  "), ["a", "b", "d"])

    def test_takes_profile_links_in_every_form(self) -> None:
        lines = ["https://www.instagram.com/someone/tagged/", "https://m.instagram.com/Some.One_1",
                 "HTTPS://INSTAGRAM.COM/x/", "http://instagram.com/y?x=1#f", "https://www.instagram.com:443/z/reels"]
        self.assertEqual(self.read("\n".join(lines)), ["someone", "some.one_1", "x", "y", "z"])

    def test_refuses_what_is_not_a_profile(self) -> None:
        for line in ["https://www.instagram.com/stories/nasa/", "https://www.instagram.com/stories/highlights/1/",
                     "https://www.instagram.com/nasa/saved/", "https://www.instagram.com/nasa/p/C1/",
                     "https://www.instagram.com/reel/C1/", "https://www.instagram.com/explore/",
                     "https://www.instagram.com/s/aGlnaGxpZ2h0OjE=", "https://notinstagram.com/nasa/",
                     "https://www.instagram.com/nasa/reels/x/", "https://www.instagram.com/nasa/Reels/",
                     "https://www.instagram.com/", "https://www.instagram.com:x/nasa/", "ftp://instagram.com/nasa",
                     "@", "a" * 31, "naKsa", "\x1cnasa", "two words"]:
            with self.assertRaises(ValueError, msg=line):
                self.read(line)

    def test_trims_as_the_app_does(self) -> None:
        self.assertEqual(self.read("a\n﻿b\n c　\n@" + "d" * 30), ["a", "b", "c", "d" * 30])

    def test_keeps_the_first_of_names_written_twice(self) -> None:
        self.assertEqual(self.read("NASA\nb\n@Nasa\nhttps://www.instagram.com/nasa/"), ["nasa", "b"])

    def test_an_empty_file_and_a_long_one(self) -> None:
        self.assertEqual(self.read("# nothing\n\n"), [])
        names = ["user%d" % i for i in range(1001)]
        self.assertEqual(self.read("\n".join(names)), names)  # the app refuses more than 1000 when the list starts

    def test_bytes_that_are_not_utf8_make_a_line_that_is_not_a_profile(self) -> None:
        with self.assertRaises(ValueError) as cm:
            self.read(b"nasa\nna\xffsa\n")
        self.assertIn("Line 2", str(cm.exception))


class BackupProfilesTests(JobCase):
    def serve(self, **kw):
        t = super().serve(**kw)
        self.stub.features = ["posts", "profileOptions", "lists"]
        return t

    def test_posts_every_option_the_wait_and_the_name(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa", "@NatGeo"], (0, 1), highlights=False, videos=False, name="mine")
        self.assertIsInstance(run, ProfileListRun)
        self.assertEqual(self.stub.list_posted[0], {
            "profiles": ["nasa", "@NatGeo"], "wait": {"min": 0, "max": 1}, "name": "mine",
            "options": {"posts": True, "highlights": False, "tagged": False, "photos": True, "videos": False}})
        self.assertEqual((run.list["name"], run.state), ("mine", "running"))

    def test_the_defaults_and_a_single_wait(self) -> None:
        t = self.serve()
        t.backup_profiles(iter(["nasa"]))
        t.backup_profiles(["nasa"], 3, posts=False, tagged=True, photos=False)
        self.assertEqual(self.stub.list_posted[0], {
            "profiles": ["nasa"], "wait": {"min": 2, "max": 5},
            "options": {"posts": True, "highlights": True, "tagged": False, "photos": True, "videos": True}})
        self.assertEqual(self.stub.list_posted[1]["wait"], {"min": 3, "max": 3})
        self.assertEqual(self.stub.list_posted[1]["options"],
                         {"posts": False, "highlights": True, "tagged": True, "photos": False, "videos": True})

    def test_wait_polls_until_the_list_finished(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa", "natgeo"])
        self.later(0.15, lambda: self.stub.list.update(state="finished", index=1, rows=[
            {"username": "nasa", "state": "done", "files": 3, "fetched": 3},
            {"username": "natgeo", "state": "skipped", "note": "This account is private."}]))
        done = run.wait(poll=0.02)
        self.assertEqual(done["state"], "finished")
        self.assertEqual([r["state"] for r in done["rows"]], ["done", "skipped"])
        self.assertIs(run.list, done)
        self.assertGreater(self.stub.list_reads, 1)
        self.assertEqual(self.stub.list_stops, 0)

    def test_wait_returns_a_list_that_stopped_by_itself(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa"])
        self.stub.list.update(state="rateLimited", message="Instagram asked TurboDL to slow down 3 times in a row.")
        self.assertEqual(run.wait(poll=0.02)["state"], "rateLimited")

    def test_wait_timeout_leaves_the_list_running(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa"])
        began = time.monotonic()
        with self.assertRaises(TimeoutError):
            run.wait(poll=0.02, timeout=0.2)
        self.assertLess(time.monotonic() - began, 2.0)
        self.assertEqual((self.stub.list_stops, self.stub.list["state"]), (0, "running"))

    def test_ctrl_c_in_wait_stops_the_list_then_reraises(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa"])
        self.later(0.15, _thread.interrupt_main)
        with self.assertRaises(KeyboardInterrupt):
            run.wait(poll=1.0)  # the Ctrl+C comes during the first wait between two reads
        self.assertEqual((self.stub.list_stops, self.stub.list["state"]), (1, "stopped"))

    def test_refresh_and_stop(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa"])
        self.stub.list["index"] = 0
        self.stub.list["progress"] = {"done": 4, "total": 9}
        self.assertEqual(run.refresh()["progress"], {"done": 4, "total": 9})
        self.assertEqual(run.stop()["state"], "stopped")
        self.assertEqual((run.state, self.stub.list_stops), ("stopped", 1))

    def test_a_list_closed_in_the_app(self) -> None:
        t = self.serve()
        run = t.backup_profiles(["nasa"])
        self.stub.list = None
        with self.assertRaises(TurboDLError) as cm:
            run.wait(poll=0.02)
        self.assertEqual(str(cm.exception), "The list was closed in TurboDL.")

    def test_the_apps_refusal_surfaces_as_the_clients_error(self) -> None:
        t = self.serve()
        self.stub.list_refusal = (409, "Close the list that is there first.")
        with self.assertRaises(TurboDLError) as cm:
            t.backup_profiles(["nasa"])
        self.assertEqual(str(cm.exception), "Close the list that is there first.")

    def test_an_old_app_is_refused_before_anything_is_sent(self) -> None:
        t = self.serve()
        self.stub.features = ["posts", "profileOptions"]
        with self.assertRaises(TurboDLError) as cm:
            t.backup_profiles(["nasa"])
        self.assertEqual(str(cm.exception), OLD_APP)
        self.assertEqual(self.stub.list_posted, [])


if __name__ == "__main__":
    unittest.main()
