"""Task HTTP contract tests. SQL/RLS live verification is a separate deployment check."""
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

from api.tasks import handler
from api.shared import supabase

TEACHER = "00000000-0000-4000-8000-000000000010"
ALICE = "00000000-0000-4000-8000-000000000001"
BOB = "00000000-0000-4000-8000-000000000002"
OUTSIDER = "00000000-0000-4000-8000-000000000003"
NOW = "2026-11-24T00:00:00+00:00"


def task(**changes):
    return {"request_id": str(uuid4()), "title": "Review arrays", "description": "Write a solution",
            "subject": "Computer Science", "task_type": "homework", "priority": "high",
            "due_at": "2026-11-25T09:00:00+05:30", "estimated_minutes": 45,
            "audience": "personal", "assigned_to": None, "batch_id": None, "status": "pending", **changes}


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())


class FakeSupabase:
    def __init__(self):
        self.rows, self.recipients, self.notifications, self.calls = {}, {}, {}, []
        self.failure, self.page_rows = None, None
        self.anonymous = False

    def error(self, request, code):
        raise HTTPError(request.full_url, int(code[2:]), "Fixture", {}, Response({"code": code, "message": "private internal details"}))

    def __call__(self, request, timeout):
        self.calls.append(request)
        if self.failure:
            raise self.failure
        assert timeout == 12
        assert request.get_header("Apikey") == "sb_publishable_test"
        token = request.get_header("Authorization")
        uid = {"Bearer teacher-token": TEACHER, "Bearer alice-token": ALICE, "Bearer bob-token": BOB,
               "Bearer outsider-token": OUTSIDER}.get(token)
        if uid is None:
            self.error(request, "PT401")
        path = urlsplit(request.full_url).path
        if path == "/auth/v1/user":
            # Editable metadata deliberately claims teacher for Alice; context remains authoritative.
            return Response({"id": uid, "is_anonymous": self.anonymous, "user_metadata": {"role": "teacher"}})
        assert path.startswith("/rest/v1/rpc/mannsathi_task_")
        assert request.get_method() == "POST"
        payload = json.loads(request.data)
        action = path.split("mannsathi_task_", 1)[1]
        if action == "context":
            return Response({"role": "teacher" if uid == TEACHER else "student", "user_id": uid,
                             "batches": [{"id": "25cs", "label": "25CS"}] if uid != OUTSIDER else [],
                             "students": [{"id": ALICE, "full_name": "Alice", "batch_id": "25cs"},
                                          {"id": BOB, "full_name": "Bob", "batch_id": "25cs"}] if uid == TEACHER else []})
        if action == "list":
            rows = self.page_rows if self.page_rows is not None else [self.project(row, uid) for row in self.rows.values() if self.visible(row, uid)]
            return Response(rows[payload["p_offset"]:payload["p_offset"] + payload["p_limit"]])
        if action == "create":
            data = payload["p_data"]
            assert "created_by" not in data and "user_id" not in data
            request_id = payload["p_request_id"]
            existing = next((row for row in self.rows.values() if row["request_id"] == request_id and row["created_by"] == uid), None)
            if existing:
                return Response(self.project(existing, uid))
            assigned = data["audience"] != "personal"
            if assigned and (uid != TEACHER or data["batch_id"] != "25cs"):
                self.error(request, "PT403")
            targets = [ALICE, BOB] if data["audience"] == "class" else [data["assigned_to"]] if assigned else []
            if any(target not in {ALICE, BOB} for target in targets):
                self.error(request, "PT403")
            row = {**data, "id": str(uuid4()), "request_id": request_id, "created_by": uid,
                   "assigned_to": data["assigned_to"] if assigned else uid,
                   "created_at": NOW, "updated_at": NOW, "completed_at": NOW if data["status"] == "completed" else None}
            self.rows[row["id"]] = row
            for target in targets:
                self.recipients[row["id"], target] = "pending"
                note = {"id": str(uuid4()), "user_id": target, "task_id": row["id"], "title": "New work assigned",
                        "message": "Teacher assigned you work", "created_at": NOW, "read_at": None}
                self.notifications[note["id"]] = note
            return Response(self.project(row, uid))
        if action == "notifications":
            notes = [note for note in self.notifications.values() if note["user_id"] == uid]
            return Response({"notifications": notes, "unread_count": sum(note["read_at"] is None for note in notes)})
        if action == "read_notification":
            note = self.notifications.get(payload["p_id"])
            if not note or note["user_id"] != uid:
                self.error(request, "PT404")
            note["read_at"] = NOW
            return Response({"read": True})
        row = self.rows.get(payload["p_id"])
        if not row or not self.visible(row, uid):
            self.error(request, "PT404")
        if action in {"edit", "delete"} and row["created_by"] != uid:
            self.error(request, "PT404")
        if action == "edit":
            assert not {"created_by", "assigned_to", "batch_id", "audience", "status"} & set(payload["p_data"])
            row.update(payload["p_data"])
        elif action == "delete":
            self.rows.pop(row["id"])
            return Response({"deleted": True})
        elif action == "status":
            if row["audience"] == "personal":
                row["status"] = payload["p_status"]
                row["completed_at"] = NOW if row["status"] == "completed" else None
            elif (row["id"], uid) in self.recipients:
                self.recipients[row["id"], uid] = payload["p_status"]
            else:
                self.error(request, "PT403")
        else:
            raise AssertionError("Unknown RPC " + action)
        return Response(self.project(row, uid))

    def visible(self, row, uid):
        return row["created_by"] == uid or (row["id"], uid) in self.recipients

    def project(self, row, uid):
        result = {**row, "user_id": uid, "assigned_by": "Teacher"}
        if row["audience"] != "personal" and row["created_by"] != uid:
            result["status"] = self.recipients[row["id"], uid]
            result["completed_at"] = NOW if result["status"] == "completed" else None
        return result


class TaskAPI(unittest.TestCase):
    def setUp(self):
        self.store = FakeSupabase()
        self.env = patch.dict("os.environ", {"SUPABASE_URL": "https://task-test.supabase.co", "SUPABASE_KEY": "sb_publishable_test"})
        self.transport = patch.object(supabase, "urlopen", self.store)
        self.env.start(); self.transport.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.transport.stop(); self.env.stop()

    def call(self, method="GET", action="list", body=None, uid="alice-token", identifier=None, raw=None, headers=None, query=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        path = "/api/tasks?" + (query if query is not None else "action=" + action + ("&id=" + identifier if identifier else ""))
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if uid is not None:
            request_headers["Authorization"] = "Bearer " + uid
        payload = raw if raw is not None else json.dumps(body) if body is not None else None
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read()), dict(response.getheaders())
        connection.close()
        return result

    def create(self, body=None, uid="alice-token"):
        status, data, _ = self.call("POST", "create", body or task(), uid)
        self.assertEqual(status, 201, data)
        return data["task"]

    def test_personal_crud_status_reopen_and_persistence(self):
        row = self.create(task(title="  Arrays  "))
        self.assertEqual(row["title"], "Arrays")
        self.assertEqual(row["created_by"], ALICE)
        self.assertEqual(row["assigned_to"], ALICE)
        self.assertEqual(row["due_at"], "2026-11-25T03:30:00+00:00")
        status, data, headers = self.call()
        self.assertEqual((status, len(data["tasks"])), (200, 1))
        self.assertEqual(headers["Cache-Control"], "no-store")
        edit = {key: row[key] for key in ("title", "description", "subject", "task_type", "priority", "due_at", "estimated_minutes")}
        edit["title"] = "Updated"
        self.assertEqual(self.call("PATCH", "edit", edit, identifier=row["id"])[1]["task"]["title"], "Updated")
        self.assertEqual(self.call("PATCH", "status", {"status": "completed"}, identifier=row["id"])[1]["task"]["status"], "completed")
        reopened = self.call("PATCH", "status", {"status": "pending"}, identifier=row["id"])[1]["task"]
        self.assertIsNone(reopened["completed_at"])
        self.assertEqual(self.call("DELETE", "delete", identifier=row["id"])[1], {"deleted": True})
        self.assertEqual(self.call()[1]["tasks"], [])

    def test_context_ignores_editable_teacher_metadata(self):
        status, result, _ = self.call(action="context")
        self.assertEqual((status, result["role"]), (200, "student"))
        self.assertEqual(result["students"], [])
        result = self.call(action="context", uid="teacher-token")[1]
        self.assertEqual(result["role"], "teacher")
        self.assertEqual({student["id"] for student in result["students"]}, {ALICE, BOB})

    def test_students_cannot_assign_or_supply_identity(self):
        for changed in ({"created_by": TEACHER}, {"user_id": BOB}, {"role": "teacher"}, {"assigned_to": BOB}):
            self.assertEqual(self.call("POST", "create", task(**changed))[0], 400)
        self.assertEqual(self.call("POST", "create", task(audience="class", batch_id="25cs"))[0], 403)
        self.assertEqual(len(self.store.rows), 0)

    def test_teacher_single_student_assignment_is_private(self):
        row = self.create(task(audience="student", batch_id="25cs", assigned_to=ALICE), "teacher-token")
        self.assertEqual(len(self.call()[1]["tasks"]), 1)
        self.assertEqual(self.call(uid="bob-token")[1]["tasks"], [])
        self.assertEqual(len(self.call(action="notifications")[1]["notifications"]), 1)
        self.assertEqual(self.call(action="notifications", uid="bob-token")[1]["unread_count"], 0)
        self.assertEqual(self.call("DELETE", "delete", uid="bob-token", identifier=row["id"])[0], 404)

    def test_teacher_class_assignment_has_independent_student_status(self):
        row = self.create(task(audience="class", batch_id="25cs"), "teacher-token")
        self.assertEqual(len(self.store.recipients), 2)
        self.assertEqual(len(self.store.notifications), 2)
        self.assertEqual(self.call(uid="outsider-token")[1]["tasks"], [])
        self.call("PATCH", "status", {"status": "completed"}, identifier=row["id"])
        self.assertEqual(self.call()[1]["tasks"][0]["status"], "completed")
        self.assertEqual(self.call(uid="bob-token")[1]["tasks"][0]["status"], "pending")
        self.assertEqual(self.call("PATCH", "status", {"status": "completed"}, uid="teacher-token", identifier=row["id"])[0], 403)
        self.assertEqual(self.call("PATCH", "edit", {"title": "Tampered"}, identifier=row["id"])[0], 404)

    def test_teacher_cannot_target_other_class_or_unapproved_student(self):
        self.assertEqual(self.call("POST", "create", task(audience="class", batch_id="other"), "teacher-token")[0], 403)
        self.assertEqual(self.call("POST", "create", task(audience="student", batch_id="25cs", assigned_to=OUTSIDER), "teacher-token")[0], 403)
        self.assertEqual(self.call("POST", "create", task(audience="class", batch_id="25cs", status="completed"), "teacher-token")[0], 400)
        self.assertFalse(self.store.rows)

    def test_assignment_retry_does_not_duplicate_records_or_notifications(self):
        payload = task(audience="class", batch_id="25cs")
        one, two = self.create(payload, "teacher-token"), self.create(payload, "teacher-token")
        self.assertEqual(one["id"], two["id"])
        self.assertEqual((len(self.store.rows), len(self.store.recipients), len(self.store.notifications)), (1, 2, 2))

    def test_private_notification_read_and_unread_count(self):
        self.create(task(audience="class", batch_id="25cs"), "teacher-token")
        data = self.call(action="notifications")[1]
        note_id = data["notifications"][0]["id"]
        self.assertEqual(data["unread_count"], 1)
        self.assertEqual(self.call("PATCH", "read", {}, "bob-token", identifier=note_id)[0], 404)
        self.assertEqual(self.call("PATCH", "read", {"user_id": BOB}, identifier=note_id)[0], 400)
        self.assertEqual(self.call("PATCH", "read", {}, identifier=note_id)[1], {"read": True})
        self.assertEqual(self.call(action="notifications")[1]["unread_count"], 0)
        self.assertEqual(self.call(action="notifications", uid="bob-token")[1]["unread_count"], 1)

    def test_bad_input_size_json_query_and_methods(self):
        invalid = [task(title=" "), task(estimated_minutes=True), task(estimated_minutes=0), task(estimated_minutes=10081),
                   task(priority="admin"), task(status="cancelled"), task(due_at="2026-11-24T09:00"),
                   task(task_type="unknown"), task(description="x" * 5001), task(subject="x" * 121),
                   task(request_id="not-uuid"), task(title="Null\x00byte")]
        for payload in invalid:
            self.assertEqual(self.call("POST", "create", payload)[0], 400, payload)
        self.assertEqual(self.call("POST", "create", raw="{bad")[0], 400)
        self.assertEqual(self.call("POST", "create", raw='{"estimated_minutes":NaN}')[0], 400)
        self.assertEqual(self.call("POST", "create", task(), headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "create", raw="x" * 32001)[0], 400)
        self.assertEqual(self.call(query="action=list&action=context")[0], 400)
        self.assertEqual(self.call(query="action=list&user_id=" + BOB)[0], 400)
        self.assertEqual(self.call("PATCH", "edit", {"title": "Changed", "audience": "class"}, identifier=str(uuid4()))[0], 400)
        self.assertEqual(self.call("PUT")[0], 405)

    def test_missing_invalid_anonymous_auth_and_private_ids(self):
        self.assertEqual(self.call(uid=None)[0], 401)
        self.assertEqual(self.call(uid="fabricated-token")[0], 401)
        self.store.anonymous = True
        self.assertEqual(self.call()[0], 403)
        self.store.anonymous = False
        row = self.create()
        foreign = self.call("PATCH", "status", {"status": "completed"}, "bob-token", identifier=row["id"])
        missing = self.call("PATCH", "status", {"status": "completed"}, "bob-token", identifier=str(uuid4()))
        self.assertEqual(foreign[0:2], missing[0:2])
        self.assertNotIn("private internal details", json.dumps(foreign))

    def test_pagination_returns_all_authorized_tasks(self):
        self.store.page_rows = [{"id": str(uuid4()), "created_by": ALICE, "title": str(index)} for index in range(501)]
        status, data, _ = self.call()
        self.assertEqual((status, len(data["tasks"])), (200, 501))
        calls = [request for request in self.store.calls if request.full_url.endswith("mannsathi_task_list")]
        self.assertEqual([json.loads(request.data)["p_offset"] for request in calls], [0, 500])

    def test_network_and_missing_migration_errors_are_safe(self):
        self.store.failure = URLError("sb_secret_do_not_expose")
        status, body, _ = self.call()
        self.assertEqual(status, 502)
        self.assertNotIn("sb_secret", json.dumps(body))
        self.store.failure = None
        original = self.store.__call__
        def missing_rpc(request, timeout):
            if "/rpc/" in request.full_url:
                raise HTTPError(request.full_url, 404, "Missing function", {}, Response({"code": "PGRST202"}))
            return original(request, timeout)
        with patch.object(supabase, "urlopen", missing_rpc):
            self.assertEqual(self.call()[0], 503)


if __name__ == "__main__":
    unittest.main()
