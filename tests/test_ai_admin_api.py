"""Exercise the HTTP entry points with an isolated Supabase Auth/PostgREST transport."""
import csv
import http.client
import io
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from api.admin import handler
from api.shared import ai_service, supabase
from local_test import LocalHandler, public_file

OWNER = "00000000-0000-4000-8000-000000000010"
STUDENT = "00000000-0000-4000-8000-000000000001"
TEACHER = "00000000-0000-4000-8000-000000000011"


class Reply(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())


class ServerTest(unittest.TestCase):
    def serve(self, cls):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), cls)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, path, method="GET", token="owner", body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        conn.request(method, path, data, headers)
        res = conn.getresponse()
        status, raw, headers = res.status, res.read(), dict(res.getheaders())
        conn.close()
        return status, raw, headers


class AdminHTTP(ServerTest):
    def setUp(self):
        self.calls = []
        self.gate = True
        self.report = {}
        self.snapshot = {}
        self.project = "mannsathi-test"
        self.env = self.enterContext(patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_KEY": "sb_publishable_example",
            "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_server_test", "GEMINI_CLOUD_PROJECT": self.project,
            "GEMINI_API_KEY": "key-never-returned",
        }))
        self.enterContext(patch.object(supabase, "urlopen", self.auth_request))
        self.enterContext(patch.object(ai_service._transport, "open", self.sql))
        self.serve(handler)

    def auth_request(self, req, timeout):
        self.assertTrue(req.full_url.endswith("/auth/v1/user"))
        self.assertEqual(req.get_header("Apikey"), "sb_publishable_example")
        name = req.get_header("Authorization").split()[1]
        uid = {"owner": OWNER, "student": STUDENT, "teacher": TEACHER, "anonymous": STUDENT}.get(name)
        if not uid:
            raise HTTPError(req.full_url, 401, "unauthorized", {}, Reply({}))
        return Reply({"id": uid, "is_anonymous": name == "anonymous", "user_metadata": {"role": "admin"}})

    def sql(self, req, timeout):
        name = req.full_url.split("/")[-1]
        args = json.loads(req.data)
        self.calls.append((name, args))
        self.assertEqual(req.get_header("Apikey"), "sb_secret_server_test")
        self.assertIsNone(req.get_header("Authorization"))
        if args["p_admin_id"] != OWNER or not self.gate:
            code = 429 if not self.gate else 403
            raise HTTPError(req.full_url, code, "fixture", {}, Reply({"code": f"PT{code}"}))
        if name == "mannsathi_ai_admin_gate":
            return Reply(True)
        if name == "mannsathi_ai_admin_change":
            return Reply(args["p_values"])
        if name == "mannsathi_ai_provider_snapshot":
            return Reply(self.snapshot)
        self.assertEqual(name, "mannsathi_ai_report")
        return Reply(self.report)

    def test_access_checks_verified_identity_and_independent_gate_each_time(self):
        for token in (None, "expired", "anonymous", "student", "teacher"):
            for path in ("?action=access", "?action=student&user_id="+STUDENT, "?action=export", "?action=settings", "?action=billing"):
                code, raw, _ = self.call("/api/admin"+path, token=token)
                self.assertIn(code, [401,403])
                self.assertNotIn(STUDENT.encode(), raw)
        self.assertTrue(all(n == "mannsathi_ai_admin_gate" for n, _ in self.calls))
        status, body, headers = self.call("/api/admin?action=access")
        self.assertEqual((status,json.loads(body)), (200,{"admin":True}))
        self.assertIn("no-store", headers["Cache-Control"])
        self.gate = False
        self.assertEqual(self.call("/api/admin?action=export")[0],429)

    def test_ordinary_members_cannot_modify_policies_or_supply_actor(self):
        for token in ("teacher","student"):
            self.assertEqual(self.call("/api/admin?action=global","POST",token,{"values":{"enabled":False}})[0],403)
        self.assertEqual(self.call("/api/admin?action=global","POST",body={"admin_id":OWNER,"values":{"enabled":True}})[0],400)
        self.assertFalse(any(n == "mannsathi_ai_admin_change" for n,_ in self.calls))

    def test_validated_filtering_and_pagination(self):
        self.report={"rows":[],"total":0,"page":2,"page_size":5}
        query = "&start=2026-02-01&end=2026-02-28&class_code=25cs&division=A&status=warning&sort=tokens&q=Alice&page=2&page_size=5"
        self.assertEqual(self.call("/api/admin?action=students"+query)[0],200)
        filters=self.calls[-1][1]["p_filters"]
        self.assertEqual(filters["page"],2)
        self.assertEqual(filters["class_code"],"25cs")
        for suffix in ("&page=0","&page_size=101","&page=2&page=3","&start=2020-01-01",
                       "&start=2020-01-01&end=2022-01-01","&sort=invalid","&status=invalid","&user_id="+STUDENT):
            self.assertEqual(self.call("/api/admin?action=students"+suffix)[0],400)
        for suffix in ("?action=student", "?action=logs&user_id=wrong", "?action=billing&project=other"):
            self.assertEqual(self.call("/api/admin"+suffix)[0],400)

    def test_relative_periods_resolve_using_server_utc(self):
        with patch("api.admin.datetime", wraps=datetime) as clock:
            clock.now.return_value=datetime(2024,3,1,0,0,1,tzinfo=timezone.utc)
            for period,expected in (("previous",("2024-02-01","2024-02-29")),("month",("2024-03-01","2024-03-01")),
                                    ("today",("2024-03-01","2024-03-01")),("7",("2024-02-24","2024-03-01")),
                                    ("30",("2024-02-01","2024-03-01"))):
                for action in ("overview","students","logs","audit","student&user_id="+STUDENT,"export"):
                    self.report={"rows":[],"total":0}
                    code,raw,_=self.call("/api/admin?action="+action+"&period="+period)
                    self.assertEqual(code,200)
                    filters=self.calls[-1][1]["p_filters"]
                    self.assertEqual((filters["start"],filters["end"]),expected)
                    self.assertNotIn("period",filters)
                    if action != "export":
                        self.assertEqual(json.loads(raw)["start"],expected[0])
            clock.now.return_value=datetime(2025,1,1,0,0,0,tzinfo=timezone.utc)
            self.call("/api/admin?action=overview&period=previous")
            self.assertEqual(self.calls[-1][1]["p_filters"],{"start":"2024-12-01","end":"2024-12-31"})
            clock.now.assert_called_with(timezone.utc)
            for suffix in ("&period=weekly","&period=today&start=2025-01-01","&period=7&start=2025-01-01&end=2025-01-01"):
                self.assertEqual(self.call("/api/admin?action=audit"+suffix)[0],400)

    def test_validated_policy_and_pricing_changes(self):
        for value in (False, True):
            status, _, _ = self.call("/api/admin?action=student_policy","POST",body={"user_id":STUDENT,
                "values":{"enabled":value,"daily_token_limit":0,"monthly_token_limit":None},"reason":"reviewed"})
            self.assertEqual(status,200)
            self.assertEqual(self.calls[-1][1]["p_target"],STUDENT)
            self.assertEqual(self.calls[-1][1]["p_admin_id"],OWNER)
        for values in ({"enabled":1}, {"monthly_token_limit":-1}, {"warning_thresholds":[75,75]},
                       {"guest_token_limit":True},{"monthly_budget":-10},{"user_id":OWNER}):
            self.assertEqual(self.call("/api/admin?action=global","POST",body={"values":values})[0],400)
        self.assertEqual(self.call("/api/admin?action=global","POST",body=b'{"values":{"enabled":true,"enabled":false}}')[0],400)
        self.assertEqual(self.call("/api/admin?action=pricing","POST",body={"values":{
            "model":"gemini-test","input_per_million":0,"output_per_million":1.5}})[0],200)

    def test_csv_export_limits_and_escapes_cells(self):
        self.report={"rows":[{"request_id":"test","model":"=formula","status":"success","message":"private conversation"}],"total":1}
        status, raw, headers=self.call("/api/admin?action=export&feature=chat")
        self.assertEqual(status,200)
        self.assertIn("attachment",headers["Content-Disposition"])
        row=list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))[0]
        self.assertEqual(row["model"],"'=formula")
        self.assertNotIn(b"private conversation",raw)
        self.report["total"]=10001
        self.assertEqual(self.call("/api/admin?action=export")[0],502)

    def test_provider_missing_invalid_and_isolated_to_project(self):
        self.report={"errors":[],"rate_limits":0,"last_success":None,"last_failure":None}
        for snapshot in ({}, {"project":"another","metrics":[{}]},
                         {"project":self.project,"metrics":[{"project":self.project,"reported_limit":-1,"metric":"RPM"}]}):
            self.snapshot=snapshot
            status,raw,_=self.call("/api/admin?action=provider")
            self.assertEqual(status,200)
            self.assertEqual(json.loads(raw)["metrics"],[])
            self.assertEqual(self.calls[-1][1]["p_project"],self.project)
            self.assertNotIn(b"key-never-returned",raw)
        os.environ.pop("GEMINI_CLOUD_PROJECT")
        self.call("/api/admin?action=provider")
        self.assertIsNone(self.calls[-1][1]["p_project"])

    def test_actual_and_estimated_billing_use_distinct_sources(self):
        self.report={"budget":10,"estimated_cost":2,"actual_spend":None,"budget_basis":"estimated_application_cost","remaining_budget":8}
        data=json.loads(self.call("/api/admin?action=billing")[1])
        self.assertIsNone(data["actual_spend"]); self.assertEqual(data["remaining_budget"],8)
        for actual in [0, 3.5]:
            self.snapshot={"actual_spend":actual,"project":self.project,"last_billing_update":"2026-11-26T09:00:00Z"}
            data=json.loads(self.call("/api/admin?action=billing")[1])
            self.assertEqual(data["actual_spend"],actual); self.assertEqual(data["estimated_cost"],2)
            self.assertEqual(data["remaining_budget"],10-actual); self.assertEqual(data["budget_pct"],10*actual)
            self.assertEqual(data["budget_basis"],"actual_provider_spend")


class LocalFiles(ServerTest):
    def test_static_allowlist_for_get_and_head(self):
        # All samples and any symlink remain inside a temporary local fixture.
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/"js").mkdir()
            for name in (".env","api.py","index.html","js/app.js","js/note.txt"):
                (root/name).write_text("fixture", encoding="utf-8")
            self.enterContext(patch("local_test.ROOT", folder))
            quiet = type("QuietLocal", (LocalHandler,), {"log_message":lambda *args:None})
            self.serve(quiet)
            for method in ("HEAD","GET"):
                for path in ("/.env", "/.git/config", "/api.py", "/js/", "/js/note.txt", "/js/%2e%2e/.env", "/js/..%5c.env"):
                    self.assertEqual(self.call(path,method)[0],404,(method,path))
                for path in ("/","/index.html","/js/app.js?v=2"):
                    self.assertEqual(self.call(path,method)[0],200)
            try:
                (root/"js/private.js").symlink_to(root/".env")
            except OSError:
                return  # Windows installations may require elevated symlink privileges.
            self.assertIsNone(public_file("/js/private.js",root))


if __name__ == "__main__":
    unittest.main()
