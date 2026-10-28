import ast
import glob
import os
import sys
import tempfile
import threading
import time
import unittest
import warnings
from unittest import mock

from turbodl_client import AppNotReachable, TurboDL, TurboDLError
from turbodl_client import _discover
from tests.stub import StubApi, free_port, make_job, write_api_file


class ClientCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.stub = None

    def tearDown(self) -> None:
        if self.stub:
            self.stub.stop()
        self._tmp.cleanup()

    def serve(self, **kw):
        self.stub = StubApi(**kw).start()
        write_api_file(self.tmp, self.stub.port)
        return TurboDL(user_data=self.tmp)


class ClientTests(ClientCase):
    def test_finds_the_app_through_api_json(self) -> None:
        self.assertEqual(self.serve().info()["version"], "9.9.9")

    def test_never_opened(self) -> None:
        with self.assertRaises(AppNotReachable) as cm:
            TurboDL(user_data=self.tmp)
        self.assertEqual(str(cm.exception), "TurboDL hasn't been opened on this computer yet. Open it once, then try again.")

    def test_starts_the_app_and_waits(self) -> None:
        port = free_port()
        marker = os.path.join(self.tmp, "started")
        code = "open(%r, 'w').close()" % marker
        write_api_file(self.tmp, port, launch={"file": sys.executable, "args": ["-c", code]})
        holder = []

        def later() -> None:
            for _ in range(200):
                if os.path.exists(marker):
                    break
                time.sleep(0.05)
            time.sleep(1)
            holder.append(StubApi(port=port).start())

        t = threading.Thread(target=later, daemon=True)
        t.start()
        try:
            self.assertEqual(TurboDL(user_data=self.tmp, timeout=8).info()["api"], 1)
        finally:
            t.join(10)
            for s in holder:
                s.stop()

    def test_start_timeout(self) -> None:
        write_api_file(self.tmp, free_port(), launch={"file": sys.executable, "args": ["-c", "pass"]})
        with self.assertRaises(AppNotReachable) as cm:
            TurboDL(user_data=self.tmp, timeout=0.5)
        self.assertEqual(str(cm.exception), "TurboDL didn't start within 0.5 seconds.")

    def test_start_false_does_not_launch(self) -> None:
        marker = os.path.join(self.tmp, "started")
        write_api_file(self.tmp, free_port(),
                       launch={"file": sys.executable, "args": ["-c", "open(%r, 'w').close()" % marker]})
        with self.assertRaises(AppNotReachable):
            TurboDL(user_data=self.tmp, start=False, timeout=0.5)
        time.sleep(0.5)
        self.assertFalse(os.path.exists(marker))

    def test_null_port_returns_the_apps_message_after_the_grace(self) -> None:
        write_api_file(self.tmp, None, error="Port 1 is taken.", launch={"file": sys.executable, "args": ["-c", "pass"]})
        began = time.time()
        with mock.patch.object(_discover, "PORT_GRACE", 0.3), self.assertRaises(AppNotReachable) as cm:
            TurboDL(user_data=self.tmp, timeout=30)
        self.assertEqual(str(cm.exception), "Port 1 is taken.")
        self.assertLess(time.time() - began, 5)

    def test_null_port_without_error_uses_the_fixed_message(self) -> None:
        write_api_file(self.tmp, None, launch={"file": sys.executable, "args": ["-c", "pass"]})
        with mock.patch.object(_discover, "PORT_GRACE", 0.3), self.assertRaises(AppNotReachable) as cm:
            TurboDL(user_data=self.tmp, timeout=30)
        self.assertEqual(str(cm.exception), "TurboDL couldn't open its local port. Pick another port in TurboDL's Settings.")

    def test_starting_the_app_leaves_no_resource_warning(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _discover._spawn({"file": sys.executable, "args": ["-c", "import time; time.sleep(0.5)"]})
        self.assertEqual([str(w.message) for w in caught if issubclass(w.category, ResourceWarning)], [])

    def test_refuses_another_api_version(self) -> None:
        self.stub = StubApi(api=2).start()
        write_api_file(self.tmp, self.stub.port)
        with self.assertRaises(TurboDLError) as cm:
            TurboDL(user_data=self.tmp)
        self.assertEqual(str(cm.exception), "This turbodl-client speaks API 1, but TurboDL speaks API 2. Update turbodl-client.")

    def test_add_sends_the_options_and_an_absolute_dir(self) -> None:
        t = self.serve()
        job = t.add("https://example.com/v", "rel", audio=True, max_height=720, collections=["Trips"])
        sent = self.stub.posted[0]
        self.assertEqual(sent["dir"], os.path.abspath("rel"))
        self.assertEqual(sent["options"], {"audio": True, "maxHeight": 720, "collections": ["Trips"]})
        self.assertNotIn("name", sent)
        self.assertEqual((job.id, job.state, job.ended), ("j1", "queued", False))

    def test_add_without_options_sends_none(self) -> None:
        t = self.serve()
        t.add("https://example.com/v")
        self.assertEqual(self.stub.posted[0], {"url": "https://example.com/v"})

    def test_reads_jobs_with_non_ascii_paths(self) -> None:
        t = self.serve()
        path = "C:\\Users\\Çağrı\\a.jpg"
        self.stub.jobs["j9"] = make_job("j9", files=[path], state="done", reason="done", failedItems=2, endedAt=5)
        job = t.job("j9")
        self.assertEqual(job.files, [path])
        self.assertEqual((job.failed_items, job.ended_at, job.ended), (2, 5, True))
        self.assertEqual([j.id for j in t.jobs()], ["j9"])

    def test_refresh_and_cancel(self) -> None:
        t = self.serve()
        job = t.add("https://example.com/v")
        self.stub.jobs["j1"]["state"] = "running"
        self.assertEqual(job.refresh().state, "running")
        self.assertEqual(job.cancel().reason, None)
        self.assertEqual(t.cancel("j1").state, "cancelled")

    def test_unknown_job(self) -> None:
        t = self.serve()
        with self.assertRaises(TurboDLError) as cm:
            t.job("nope")
        self.assertEqual(str(cm.exception), "No job nope.")

    def test_bad_request_message(self) -> None:
        t = self.serve()
        self.stub.fail_add = "That isn't a link."
        with self.assertRaises(TurboDLError) as cm:
            t.add("x")
        self.assertEqual(str(cm.exception), "That isn't a link.")

    def test_wrong_token(self) -> None:
        self.stub = StubApi(token="other").start()
        write_api_file(self.tmp, self.stub.port, token="tok")
        with self.assertRaises(TurboDLError) as cm:
            TurboDL(user_data=self.tmp, start=False)
        self.assertEqual(str(cm.exception), "TurboDL refused the key in api.json.")

    def test_lost_connection(self) -> None:
        t = self.serve()
        self.stub.stop()
        self.stub = None
        with self.assertRaises(AppNotReachable) as cm:
            t.jobs()
        self.assertEqual(str(cm.exception), "Lost the connection to TurboDL.")

    def test_instagram_login_and_logout(self) -> None:
        t = self.serve()
        self.assertEqual(t.instagram_login(), {"signed_in": True, "username": "alper"})
        self.assertIsNone(t.instagram_logout())

    def test_user_data_dir(self) -> None:
        self.assertEqual(_discover.user_data_dir("x"), "x")
        old = os.environ.get("TURBODL_USER_DATA")
        os.environ["TURBODL_USER_DATA"] = "env-dir"
        try:
            self.assertEqual(_discover.user_data_dir(), "env-dir")
        finally:
            if old is None:
                del os.environ["TURBODL_USER_DATA"]
            else:
                os.environ["TURBODL_USER_DATA"] = old

    def _linux_user_data_dir(self, extra: dict) -> str:
        env = {k: v for k, v in os.environ.items() if k not in ("TURBODL_USER_DATA", "XDG_CONFIG_HOME")}
        env.update(extra)
        with mock.patch.object(sys, "platform", "linux"), mock.patch.dict(os.environ, env, clear=True):
            return _discover.user_data_dir()

    def test_user_data_dir_on_linux_follows_xdg_config_home(self) -> None:
        self.assertEqual(self._linux_user_data_dir({"XDG_CONFIG_HOME": "/x/cfg"}), os.path.join("/x/cfg", "TurboDL"))

    def test_user_data_dir_on_linux_defaults_to_dot_config(self) -> None:
        expected = os.path.join(os.path.expanduser("~"), ".config", "TurboDL")
        self.assertEqual(self._linux_user_data_dir({}), expected)
        self.assertEqual(self._linux_user_data_dir({"XDG_CONFIG_HOME": ""}), expected)


class Python39Syntax(unittest.TestCase):
    def test_modules_parse_as_3_9(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        files = glob.glob(os.path.join(root, "turbodl_client", "*.py")) + glob.glob(os.path.join(root, "tests", "*.py"))
        self.assertTrue(files)
        for f in files:
            with open(f, encoding="utf-8") as fh:
                ast.parse(fh.read(), filename=f, feature_version=(3, 9))


if __name__ == "__main__":
    unittest.main()
