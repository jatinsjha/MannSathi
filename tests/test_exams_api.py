"""Exam HTTP contracts and errors; SQL permissions are exercised in exams-sql.cjs."""
import copy
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from uuid import uuid4

from api.shared import supabase
import test_calendar_api as fixture
from test_calendar_api import ALICE, BOB, FakeResponse, timed


def exam(**changes):
    return timed(category="examination", audience="class", batch_id="25cs",
                 target_division=None, assigned_to=None, **changes)


class ExamsAPI(unittest.TestCase):
    call = fixture.CalendarAPI.call
    tearDown = fixture.CalendarAPI.tearDown

    def setUp(self):
        fixture.CalendarAPI.setUp(self)
        original = self.service
        self.exam_rows = []
        self.failure_code = None

        def transport(request, timeout):
            path = urlsplit(request.full_url).path
            if not path.startswith("/rest/v1/rpc/mannsathi_exam_"):
                return original(request, timeout)
            original.calls.append(request)
            self.assertEqual(request.get_header("Apikey"), "sb_publishable_test")
            token = request.get_header("Authorization")
            self.assertIn(token, {"Bearer alice-token", "Bearer bob-token"})
            payload = json.loads(request.data)
            name = path.rsplit("_", 1)[-1]
            if self.failure_code:
                raise HTTPError(request.full_url, 400, "private detail", {}, io.BytesIO(json.dumps({"code": self.failure_code, "message": "secret"}).encode()))
            if name == "list":
                self.assertEqual(set(payload), {"p_start", "p_end", "p_time_zone", "p_offset", "p_limit"})
                rows = copy.deepcopy(self.exam_rows[payload["p_offset"]:payload["p_offset"] + payload["p_limit"]])
                for row in rows:
                    row["can_edit"] = token == "Bearer alice-token"
                return FakeResponse(rows)
            if token != "Bearer alice-token":
                code = "PT403" if name == "create" else "PT404"
                raise HTTPError(request.full_url, 400, "denied", {}, io.BytesIO(json.dumps({"code": code}).encode()))
            if name == "create":
                self.assertEqual(set(payload), {"p_data"})
                self.assertNotIn("user_id", payload["p_data"])
                row = {**payload["p_data"], "id": str(uuid4()), "user_id": ALICE, "source": "teacher_exam", "can_edit": True}
                self.exam_rows.append(row)
                return FakeResponse(row)
            row = next((row for row in self.exam_rows if row["id"] == payload["p_id"]), None)
            if not row:
                raise HTTPError(request.full_url, 400, "missing", {}, io.BytesIO(b'{"code":"PT404"}'))
            if name == "edit":
                row.update(payload["p_data"])
                return FakeResponse(row)
            self.exam_rows.remove(row)
            return FakeResponse({"deleted": True})

        self.transport.stop()
        self.transport = patch.object(supabase, "urlopen", transport)
        self.transport.start()

    def test_exam_contract_and_verified_token(self):
        path = "/api/calendar?action=exams"
        status, result, _ = self.call("POST", path, exam(title="  Exam  "))
        self.assertEqual(status, 201, result)
        row = result["event"]
        self.assertEqual(row["title"], "Exam")
        self.assertEqual(row["starts_at"], "2026-11-24T04:30:00+00:00")
        query = path + "&start=2026-11-24&end=2026-11-25&time_zone=Asia%2FKolkata"
        status, result, _ = self.call(path=query, token="bob-token")
        self.assertEqual(status, 200)
        self.assertFalse(result["events"][0]["can_edit"])
        self.assertEqual(self.call("POST", path, exam(), "bob-token")[0], 403)
        self.assertEqual(self.call("PATCH", path + "&id=" + row["id"], exam(), "bob-token")[0], 404)
        self.assertEqual(self.call("DELETE", path + "&id=" + row["id"], token="bob-token")[0], 404)
        self.assertEqual(self.call("PATCH", path + "&id=" + row["id"], exam(title="Changed"))[1]["event"]["title"], "Changed")
        self.assertEqual(self.call("DELETE", path + "&id=" + row["id"])[1], {"deleted": True})

    def test_inputs_fail_before_rpc(self):
        invalid = [{"user_id": BOB}, {"source": "teacher_exam"}, {"can_edit": True}, {"category": "lecture"}, {"audience": []},
                   {"audience": "division", "target_division": []}, {"audience": "division", "target_division": None},
                   {"audience": "class", "target_division": "A"}, {"audience": "class", "assigned_to": BOB},
                   {"audience": "student", "assigned_to": "invalid"}, {"batch_id": None}, {"all_day": "false"}]
        for change in invalid:
            body = {**exam(), **change}
            self.assertEqual(self.call("POST", "/api/calendar?action=exams", body)[0], 400, change)
        self.assertEqual(self.call(path="/api/calendar?action=exams&start=2026-11-24&end=2027-11-25&time_zone=UTC")[0], 400)
        self.assertEqual(self.call("POST", "/api/calendar?action=exams&user_id=" + BOB, exam())[0], 400)
        self.assertTrue(all("rpc" not in request.full_url for request in self.service.calls))
        self.assertEqual(self.call("POST", "/api/calendar?action=exams", exam(), token=None)[0], 401)

    def test_known_database_errors_are_safe(self):
        for code, expected in [("PT403", 403), ("PT404", 404), ("PT422", 400), ("PT400", 400), ("PGRST202", 503), ("PT401", 401)]:
            self.failure_code = code
            status, result, _ = self.call("POST", "/api/calendar?action=exams", exam())
            self.assertEqual(status, expected)
            self.assertNotIn("secret", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
