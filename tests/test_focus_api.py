"""Protected Focus HTTP contracts; real timer/RLS semantics tested in focus-sql.cjs."""
import http.client
import io
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from uuid import uuid4
from api.focus import handler
from api.shared import supabase

ALICE = "00000000-0000-4000-8000-000000000001"
BOB = "00000000-0000-4000-8000-000000000002"
SUBJECT = "00000000-0000-4000-8000-000000000003"
NOW = "2026-11-25T09:00:00Z"
PREFS = dict(focus_minutes=25, short_break_minutes=5, long_break_minutes=15,
             sessions_before_long=4, auto_start=False, sound=False)
FIELDS = dict(name="Mathematics", color="#bda0ed", weekly_goal_minutes=120)


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(json.dumps(data).encode())


class FocusAPI(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.failure = None
        self.override = None
        self.anonymous = False
        self.env = patch.dict("os.environ", {"SUPABASE_URL": "https://focus-test.supabase.co", "SUPABASE_KEY": "sb_publishable_test"})
        self.transport = patch.object(supabase, "urlopen", self.upstream)
        self.env.start(); self.transport.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.transport.stop(); self.env.stop()

    def upstream(self, request, timeout):
        self.calls.append(request)
        self.assertEqual(timeout, 12)
        self.assertEqual(request.get_header("Apikey"), "sb_publishable_test")
        token = request.get_header("Authorization")
        if token != "Bearer student-token":
            raise HTTPError(request.full_url, 401, "Fixture", {}, Response({"code": "PT401"}))
        if urlsplit(request.full_url).path == "/auth/v1/user":
            return Response({"id": ALICE, "is_anonymous": self.anonymous, "user_metadata": {"role": "teacher"}})
        if self.failure:
            if isinstance(self.failure, str):
                raise HTTPError(request.full_url, 409, "Fixture", {}, Response({"code": self.failure, "message": "private details never exposed"}))
            raise self.failure
        if self.override is not None:
            return Response(self.override)
        self.assertEqual(request.get_method(), "POST")
        action = request.full_url.split("mannsathi_focus_")[1]
        payload = json.loads(request.data)
        subject = {**FIELDS, "id": SUBJECT, "user_id": ALICE, "archived": False}
        session = {"id": payload.get("p_session_id", payload.get("p_id", str(uuid4()))), "user_id": ALICE,
                   "subject_id": SUBJECT, "status": "running", "focused_seconds": 0, "planned_seconds": 1500,
                   "remaining_seconds": 1500, "deadline_at": "2026-11-25T09:25:00Z"}
        values = {"subjects": {"role": "student", "subjects": [subject]},
                  "state": {"active": session, "finished": None, "server_now": NOW, "prefs": PREFS},
                  "summary": {"total_seconds": 0, "today_seconds": 0, "week_seconds": 0, "completed_sessions": 0,
                              "subjects": [], "daily": [], "history": [], "server_now": NOW},
                  "create_subject": {"subject": subject}, "edit_subject": {"subject": {**subject, "id": payload.get("p_id")}},
                  "save_prefs": {"prefs": payload.get("p_data")}, "start": {"session": session, "server_now": NOW},
                  "transition": {"session": session, "server_now": NOW}, "history": []}
        return Response(values[action])

    def call(self, method="GET", action="state", body=None, query="", token="student-token", raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if token is not None: headers["Authorization"] = "Bearer " + token
        conn.request(method, "/api/focus?action=" + action + query, raw if raw is not None else json.dumps(body) if body is not None else None, headers)
        response = conn.getresponse(); result = response.status, json.loads(response.read()), dict(response.getheaders()); conn.close()
        return result

    def test_verified_auth_and_original_token(self):
        status, data, headers = self.call(action="subjects")
        self.assertEqual(status, 200); self.assertEqual(data["role"], "student")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertTrue(self.calls[0].full_url.endswith("/auth/v1/user"))
        self.assertEqual(self.calls[1].get_header("Authorization"), "Bearer student-token")
        self.assertEqual(self.call(token=None)[0], 401)
        self.assertEqual(self.call(token="expired")[0], 401)
        self.anonymous = True; self.assertEqual(self.call()[0], 403)

    def test_subject_and_preference_validation(self):
        self.assertEqual(self.call("POST", "subject", FIELDS)[0], 201)
        self.assertEqual(self.call("PATCH", "subject", {**FIELDS, "archived": True}, "&id=" + SUBJECT)[0], 200)
        for extra in ({"user_id": BOB}, {"name": " "}, {"weekly_goal_minutes": True}, {"color": "purple"}, {"weekly_goal_minutes": 10081}):
            self.assertEqual(self.call("POST", "subject", {**FIELDS, **extra})[0], 400)
        self.assertEqual(self.call("PATCH", "prefs", PREFS)[0], 200)
        self.assertEqual(self.call("PATCH", "prefs", {**PREFS, "focus_minutes": 0})[0], 400)

    def test_start_and_actions_cannot_supply_elapsed_time(self):
        data = {"session_id": str(uuid4()), "subject_id": SUBJECT, "task_id": None, "planned_minutes": 25, "time_zone": "Asia/Kolkata"}
        self.assertEqual(self.call("POST", "start", data)[0], 201)
        for extra in ({"focused_seconds": 1500}, {"user_id": BOB}, {"planned_minutes": True}, {"time_zone": "bogus"}):
            self.assertEqual(self.call("POST", "start", {**data, **extra})[0], 400)
        for action in ("pause", "resume", "finish", "interrupt", "cancel"):
            self.assertEqual(self.call("PATCH", action, {}, "&id=" + data["session_id"])[0], 200)
            self.assertEqual(self.call("PATCH", action, {"focused_seconds": 12}, "&id=" + data["session_id"])[0], 400)

    def test_query_json_and_method_guards(self):
        self.assertEqual(self.call("GET", "summary", query="&time_zone=Asia%2FKolkata")[0], 200)
        for query in ("&time_zone=bad", "&time_zone=UTC&user_id=" + BOB, "&time_zone=UTC&time_zone=UTC"):
            self.assertEqual(self.call("GET", "summary", query=query)[0], 400)
        self.assertEqual(self.call("POST", "subject", raw='{"name":"A","name":"B"}')[0], 400)
        self.assertEqual(self.call("POST", "subject", raw='{"name":NaN}')[0], 400)
        self.assertEqual(self.call("DELETE")[0], 405)

    def test_fail_closed_private_and_unconfirmed_responses(self):
        self.override = {"role": "student", "subjects": [{**FIELDS, "archived": False, "id": SUBJECT, "user_id": BOB}]}
        self.assertEqual(self.call(action="subjects")[0], 502)
        self.override = {"total_seconds": -1, "today_seconds": 0, "week_seconds": 0, "completed_sessions": 0, "subjects": [], "daily": [], "history": []}
        self.assertEqual(self.call(action="summary", query="&time_zone=UTC")[0], 502)
        self.override = None
        for code, expected in (("PT403", 403), ("PT404", 404), ("PT409", 409), ("PT400", 400), ("42P01", 503)):
            self.failure = code; status, data, _ = self.call(); self.assertEqual(status, expected); self.assertNotIn("private details", data["error"])
        self.failure = URLError("network"); self.assertEqual(self.call()[0], 502)


if __name__ == "__main__": unittest.main()
