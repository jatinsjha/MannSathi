"""HTTP integration checks with a fake Supabase transport; no live records are touched."""
import base64
import copy
import http.client
import io
import json
import re
import threading
import unittest
from datetime import datetime
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from api.calendar import handler as CalendarHandler
from api.config import handler as ConfigHandler
from api.shared import supabase
from api.shared.validation import date_range, event_payload

ALICE = "00000000-0000-4000-8000-000000000001"
BOB = "00000000-0000-4000-8000-000000000002"
QUERY = "?start=2026-11-24&end=2026-11-25&time_zone=Asia%2FKolkata"


def timed(**changes):
    return {"title": "Lecture", "description": "Review arrays", "category": "lecture",
            "location": "Room 25", "all_day": False, "start_date": None, "end_date": None,
            "starts_at": "2026-11-24T10:00:00+05:30", "ends_at": "2026-11-24T11:00:00+05:30",
            "time_zone": "Asia/Kolkata", "reminder_minutes": 15, **changes}


def all_day(**changes):
    return timed(**{"all_day": True, "starts_at": None, "ends_at": None,
                    "start_date": "2026-11-24", "end_date": "2026-11-26", **changes})


class FakeResponse(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())


class FakeSupabase:
    """Models token verification and RLS separately from the production handler."""
    def __init__(self):
        self.rows = []
        self.calls = []
        self.auth_value = None
        self.failure = None

    def __call__(self, request, timeout):
        self.calls.append(request)
        if self.failure:
            raise self.failure
        assert request.get_header("Apikey") == "sb_publishable_test", "Never use a service-role key"
        assert timeout == 12
        token = request.get_header("Authorization")
        user_id = {"Bearer alice-token": ALICE, "Bearer bob-token": BOB}.get(token)
        if not user_id:
            raise HTTPError(request.full_url, 401, "Rejected token", {}, io.BytesIO())
        parsed = urlsplit(request.full_url)
        if parsed.path == "/auth/v1/user":
            return FakeResponse(self.auth_value if self.auth_value is not None else {"id": user_id})
        assert parsed.path == "/rest/v1/calendar_events"
        query = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        assert query["user_id"] == "eq." + user_id, "Backend must add an owner filter"
        rows = [row for row in self.rows if row["user_id"] == user_id]  # RLS model.
        if "id" in query:
            rows = [row for row in rows if row["id"] == query["id"][3:]]
        method = request.get_method()
        if method == "POST":
            payload = json.loads(request.data)
            assert payload["user_id"] == user_id
            assert not {"id", "created_at", "updated_at"} & set(payload)
            row = {**payload, "id": str(uuid4()), "created_at": "2026-11-24T00:00:00Z",
                   "updated_at": "2026-11-24T00:00:00Z"}
            self.rows.append(row)
            rows = [row]
        elif method == "PATCH":
            payload = json.loads(request.data)
            assert "user_id" not in payload
            for row in rows:
                row.update(payload)
        elif method == "DELETE":
            self.rows = [row for row in self.rows if row not in rows]
        else:
            condition = query["or"]
            upper, lower = re.search(r"starts_at\.lt\.([^,]+),ends_at\.gt\.([^\)]+)", condition).groups()
            end, start = re.search(r"start_date\.lt\.([^,]+),end_date\.gt\.([^\)]+)", condition).groups()
            rows = [row for row in rows if
                    (row["all_day"] and row["start_date"] < end and row["end_date"] > start) or
                    (not row["all_day"] and datetime.fromisoformat(row["starts_at"]) < datetime.fromisoformat(upper)
                     and datetime.fromisoformat(row["ends_at"]) > datetime.fromisoformat(lower))]
            rows.sort(key=lambda row: (row["start_date"] or "9999", row["starts_at"] or "", row["id"]))
            offset, limit = int(query["offset"]), int(query["limit"])
            rows = rows[offset:offset + limit]
        return FakeResponse(rows)


class TestHandler(CalendarHandler):
    def do_GET(self):
        if self.path == "/api/config":
            return ConfigHandler.do_GET(self)
        return super().do_GET()


class CalendarAPI(unittest.TestCase):
    def setUp(self):
        self.service = FakeSupabase()
        self.env = patch.dict("os.environ", {"SUPABASE_URL": "https://calendar-test.supabase.co",
                                           "SUPABASE_KEY": "sb_publishable_test"})
        self.transport = patch.object(supabase, "urlopen", self.service)
        self.env.start()
        self.transport.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.transport.stop()
        self.env.stop()

    def call(self, method="GET", path="/api/calendar" + QUERY, body=None, token="alice-token", raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        payload = raw if raw is not None else json.dumps(body) if body is not None else None
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read()), dict(response.getheaders())
        connection.close()
        return result

    def create(self, payload=None, token="alice-token"):
        status, data, _ = self.call("POST", "/api/calendar", payload or timed(), token)
        self.assertEqual(status, 201, data)
        return data["event"]

    def test_crud_persistence_across_requests_and_owner_isolation(self):
        event = self.create(timed(title="  Arrays  "))
        self.assertEqual(event["title"], "Arrays")
        self.assertEqual(event["starts_at"], "2026-11-24T04:30:00+00:00")
        self.assertEqual(event["user_id"], ALICE)
        status, data, headers = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(data["events"], [event])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.call(token="bob-token")[1]["events"], [])
        event_path = "/api/calendar?id=" + event["id"]
        self.assertEqual(self.call("PATCH", event_path, timed(title="Hijack"), "bob-token")[0], 404)
        self.assertEqual(self.call("DELETE", event_path, token="bob-token")[0], 404)
        status, data, _ = self.call("PATCH", event_path, timed(title="Lab", category="practical"))
        self.assertEqual(status, 200)
        self.assertEqual(data["event"]["title"], "Lab")
        self.assertEqual(self.call()[1]["events"][0]["title"], "Lab")
        self.assertEqual(self.call("DELETE", event_path)[0], 200)
        self.assertEqual(self.call()[1]["events"], [])
        self.assertEqual(self.call("DELETE", event_path)[0], 404)
        for request in self.service.calls:
            self.assertIn(request.get_header("Authorization"), {"Bearer alice-token", "Bearer bob-token"})

    def test_all_day_multiday_and_exclusive_end(self):
        event = self.create(all_day())
        self.assertIsNone(event["starts_at"])
        self.assertEqual(event["end_date"], "2026-11-26")
        self.assertEqual(len(self.call(path="/api/calendar?start=2026-11-25&end=2026-11-26&time_zone=UTC")[1]["events"]), 1)
        self.assertEqual(self.call(path="/api/calendar?start=2026-11-26&end=2026-11-27&time_zone=UTC")[1]["events"], [])

    def test_overlap_and_midnight_boundary(self):
        self.create()
        self.create(timed(title="Overlapping study", starts_at="2026-11-24T10:30:00+05:30", ends_at="2026-11-24T12:00:00+05:30"))
        self.create(timed(title="Previous night", starts_at="2026-11-23T23:00:00+05:30", ends_at="2026-11-24T00:00:00+05:30"))
        self.create(timed(title="Spans midnight", starts_at="2026-11-23T23:00:00+05:30", ends_at="2026-11-24T00:01:00+05:30"))
        self.assertEqual(len(self.call()[1]["events"]), 3)

    def test_unverified_and_anonymous_sessions_fail_closed(self):
        self.assertEqual(self.call(token=None)[0], 401)
        self.assertEqual(len(self.service.calls), 0)
        self.assertEqual(self.call(token="forged-token")[0], 401)
        self.assertEqual(len(self.service.calls), 1)
        self.service.auth_value = {"id": ALICE, "is_anonymous": True}
        self.assertEqual(self.call()[0], 403)
        self.service.auth_value = {"id": "not-a-user"}
        self.assertEqual(self.call()[0], 401)
        self.assertTrue(all(urlsplit(request.full_url).path == "/auth/v1/user" for request in self.service.calls))

    def test_client_cannot_supply_identity_or_query_filters(self):
        event = self.create()
        for key, value in {"user_id": BOB, "id": str(uuid4()), "created_at": "2026-11-24"}.items():
            with self.subTest(key=key):
                self.assertEqual(self.call("POST", "/api/calendar", timed(**{key: value}))[0], 400)
                self.assertEqual(self.call("PATCH", "/api/calendar?id=" + event["id"], timed(**{key: value}))[0], 400)
        self.assertEqual(self.call(path="/api/calendar" + QUERY + "&user_id=" + BOB)[0], 400)
        self.assertEqual(self.call(path="/api/calendar" + QUERY + "&start=2026-11-23")[0], 400)
        self.assertEqual(len(self.service.rows), 1)

    def test_invalid_event_inputs_and_ranges(self):
        cases = [timed(title="   "), timed(title="x" * 201), timed(description="x" * 5001),
                 timed(location="x" * 301), timed(category="teacher-admin"), timed(all_day="false"),
                 timed(reminder_minutes=True), timed(reminder_minutes=-1), timed(time_zone="Mars/Base"),
                 timed(starts_at="2026-11-24T10:00:00"), timed(starts_at="2026-02-30T10:00:00Z"),
                 timed(ends_at="2026-11-24T09:00:00+05:30"), timed(start_date="2026-11-24"),
                 all_day(end_date="2026-11-24"), all_day(start_date="2026-02-30"),
                 all_day(starts_at="2026-11-24T00:00:00Z"), [], None]
        for body in cases:
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/api/calendar", raw=json.dumps(body))[0], 400)
        for query in ["", "?start=2026-02-30&end=2026-03-01&time_zone=UTC",
                      "?start=2026-11-24&end=2026-11-24&time_zone=UTC",
                      "?start=2026-01-01&end=2026-12-31&time_zone=UTC",
                      "?start=2026-11-24&end=2026-11-25&time_zone=Invalid"]:
            self.assertEqual(self.call(path="/api/calendar" + query)[0], 400)
        self.assertEqual(self.service.rows, [])

    def test_bad_json_content_type_request_size_and_method(self):
        self.assertEqual(self.call("POST", "/api/calendar", raw="{")[0], 400)
        self.assertEqual(self.call("POST", "/api/calendar", raw='{"title":NaN}')[0], 400)
        self.assertEqual(self.call("POST", "/api/calendar", raw="x" * 32001)[0], 400)
        self.assertEqual(self.call("POST", "/api/calendar", timed(), headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("PATCH", "/api/calendar?id=invalid", timed())[0], 400)
        status, _, headers = self.call("PUT", "/api/calendar", timed())
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET, POST, PATCH, DELETE")

    def test_network_and_database_failures_do_not_leak_secrets(self):
        self.service.failure = URLError("private database password")
        status, result, _ = self.call()
        self.assertEqual(status, 502)
        self.assertNotIn("private database password", json.dumps(result))
        self.service.failure = None
        original = self.service

        def unavailable(request, timeout):
            if "/rest/v1/" in request.full_url:
                raise HTTPError(request.full_url, 404, "secret table metadata", {}, io.BytesIO())
            return original(request, timeout)

        with patch.object(supabase, "urlopen", unavailable):
            status, result, _ = self.call()
        self.assertEqual(status, 503)
        self.assertIn("migration", result["error"])
        self.assertNotIn("secret", json.dumps(result))

    def test_public_configuration_rejects_service_role_and_secret_keys(self):
        def jwt(role):
            payload = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
            return "header." + payload + ".signature"
        for key in ["sb_secret_PRIVATE", jwt("service_role"), "broken", ""]:
            with self.subTest(key_type=key.split("_")[0]), patch.dict("os.environ", {"SUPABASE_KEY": key}):
                status, result, _ = self.call(path="/api/config")
                self.assertEqual(status, 503)
                self.assertNotIn("supabaseKey", result)
                self.assertEqual(self.call()[0], 503)
        self.assertEqual(len(self.service.calls), 0)
        for key in ["sb_publishable_test", jwt("anon")]:
            with patch.dict("os.environ", {"SUPABASE_KEY": key, "GEMINI_API_KEY": "PRIVATE-GEMINI"}):
                status, result, _ = self.call(path="/api/config")
                self.assertEqual(status, 200)
                self.assertEqual(result["supabaseKey"], key)
                self.assertNotIn("PRIVATE-GEMINI", json.dumps(result))

    def test_pagination_returns_every_owned_event(self):
        row = {**event_payload(timed()), "user_id": ALICE, "created_at": "2026-11-24T00:00:00Z",
               "updated_at": "2026-11-24T00:00:00Z"}
        self.service.rows = [{**copy.deepcopy(row), "id": str(UUID(int=n + 1))} for n in range(501)]
        status, result, _ = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(len(result["events"]), 501)
        self.assertEqual(len({event["id"] for event in result["events"]}), 501)
        offsets = [parse_qs(urlsplit(request.full_url).query)["offset"][0] for request in self.service.calls
                   if "/rest/v1/" in request.full_url]
        self.assertEqual(offsets, ["0", "500"])

    def test_dst_ranges_use_real_local_midnights(self):
        spring = date_range({"start": "2026-03-08", "end": "2026-03-09", "time_zone": "America/New_York"})["or"]
        self.assertIn("starts_at.lt.2026-03-09T04:00:00+00:00", spring)
        self.assertIn("ends_at.gt.2026-03-08T05:00:00+00:00", spring)
        autumn = date_range({"start": "2026-11-01", "end": "2026-11-02", "time_zone": "America/New_York"})["or"]
        self.assertIn("starts_at.lt.2026-11-02T05:00:00+00:00", autumn)
        self.assertIn("ends_at.gt.2026-11-01T04:00:00+00:00", autumn)


if __name__ == "__main__":
    unittest.main()
