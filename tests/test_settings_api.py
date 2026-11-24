"""HTTP checks for profile settings, approved enrollment, and division targets."""
import json
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit
from uuid import uuid4

import test_tasks_api as base
from test_tasks_api import ALICE, BOB, OUTSIDER, TEACHER, FakeSupabase, Response, task


def settings(**changes):
    return {"full_name": "Alice Student", "roll_number": "01", "class_code": "25cs", "division": "A", **changes}


class SettingsStore(FakeSupabase):
    def __init__(self):
        super().__init__()
        self.profiles = {ALICE: settings(), BOB: settings(full_name="Bob Student", roll_number="02", division="B")}
        self.members = {ALICE: {"batch_id": "25cs", "division": "A", "status": "approved"},
                        BOB: {"batch_id": "25cs", "division": "B", "status": "approved"},
                        OUTSIDER: {"batch_id": "25cs", "division": "C", "status": "pending"}}
        self.extra_error = None
        self.empty = False
        self.last_create = None

    def __call__(self, request, timeout):
        path = urlsplit(request.full_url).path
        if not "/rpc/" in path:
            return super().__call__(request, timeout)
        uid = {"Bearer teacher-token": TEACHER, "Bearer alice-token": ALICE,
               "Bearer bob-token": BOB, "Bearer outsider-token": OUTSIDER}.get(request.get_header("Authorization"))
        if not uid:
            return super().__call__(request, timeout)
        assert request.get_header("Apikey") == "sb_publishable_test"
        assert timeout == 12 and request.get_method() == "POST"
        action = path.split("mannsathi_task_", 1)[1]
        payload = json.loads(request.data)
        if self.extra_error and action == "create":
            raise HTTPError(request.full_url, 422, "Fixture", {}, Response(self.extra_error))
        if action == "context":
            self.calls.append(request)
            roster = [] if self.empty else [{"id": person, "batch_id": member["batch_id"], "division": member["division"],
                      "full_name": self.profiles.get(person, {}).get("full_name", "Student"),
                      "roll_number": self.profiles.get(person, {}).get("roll_number", "")}
                      for person, member in self.members.items() if member["status"] == "approved"]
            return Response({"role": "teacher" if uid == TEACHER else "student", "user_id": uid,
                             "batches": [{"id": "25cs", "label": "25CS"}], "students": roster if uid == TEACHER else []})
        if action in {"settings", "save_settings"}:
            self.calls.append(request)
            if action == "save_settings":
                if uid == TEACHER:
                    self.error(request, "PT403")
                value = payload["p_data"]
                assert not {"id", "user_id", "role", "status"} & set(value)
                previous = self.members.get(uid)
                if not previous or previous["batch_id"] != value["class_code"] or previous["division"] != value["division"]:
                    self.members[uid] = {"batch_id": value["class_code"], "division": value["division"], "status": "pending"}
                self.profiles[uid] = value
            return Response({"role": "teacher" if uid == TEACHER else "student",
                             "profile": self.profiles.get(uid, settings(full_name="Teacher")),
                             "membership": self.members.get(uid),
                             "classes": [{"id": "25cs", "label": "25CS", "divisions": ["A", "B", "C"]}]})
        if action == "pending_enrollments":
            self.calls.append(request)
            if uid != TEACHER:
                self.error(request, "PT403")
            return Response([{"user_id": person, **member, "full_name": "Pending Student", "roll_number": "03"}
                             for person, member in self.members.items() if member["status"] == "pending"])
        if action == "approve_enrollment":
            self.calls.append(request)
            if uid != TEACHER or payload["p_batch"] != "25cs":
                self.error(request, "PT403")
            member = self.members.get(payload["p_user"])
            if not member or member["batch_id"] != payload["p_batch"]:
                self.error(request, "PT404")
            if member and member["division"] != payload["p_expected_division"]:
                self.error(request, "PT409")
            if not member or member["batch_id"] != payload["p_batch"] or member["status"] != "pending":
                self.error(request, "PT404")
            member["status"] = "approved" if payload["p_approve"] else "rejected"
            return Response({"updated": True, "status": member["status"]})
        if action == "create" and payload["p_data"]["audience"] == "division":
            self.calls.append(request)
            self.last_create = payload["p_data"]
            return Response({**payload["p_data"], "id": str(uuid4()), "created_by": uid})
        return super().__call__(request, timeout)


class SettingsAPI(unittest.TestCase):
    call = base.TaskAPI.call
    tearDown = base.TaskAPI.tearDown

    def setUp(self):
        base.TaskAPI.setUp(self)
        self.store = SettingsStore()
        self.transport.stop()
        from api.shared import supabase
        from unittest.mock import patch
        self.transport = patch.object(supabase, "urlopen", self.store)
        self.transport.start()

    def test_settings_are_private_and_codes_normalized(self):
        status, value, headers = self.call(action="settings")
        self.assertEqual((status, value["profile"]["full_name"]), (200, "Alice Student"))
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, result, _ = self.call("PATCH", "settings", settings(full_name="  Alice Edited  ", class_code=" 25CS ", division=" a "))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["profile"], settings(full_name="Alice Edited"))
        self.assertEqual(result["membership"]["status"], "approved")
        self.assertEqual(self.store.profiles[BOB]["full_name"], "Bob Student")

    def test_changing_division_requests_approval_instead_of_granting_access(self):
        status, result, _ = self.call("PATCH", "settings", settings(division="B"))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["membership"], {"batch_id": "25cs", "division": "B", "status": "pending"})
        self.assertEqual(self.call(action="context", uid="teacher-token")[1]["students"][0]["id"], BOB)

    def test_invalid_roll_number_is_rejected_before_settings_rpc(self):
        for roll in ["@roll", "01.2", "-01"]:
            previous = len(self.store.calls)
            status, data, _ = self.call("PATCH", "settings", settings(roll_number=roll))
            self.assertEqual(status, 400)
            self.assertIn("Roll number", data["error"])
            self.assertFalse(any("/rpc/" in call.full_url for call in self.store.calls[previous:]))

    def test_enrollment_conflict_has_a_safe_refresh_message(self):
        self.store.extra_error = {"code": "PT409", "message": "private enrollment details"}
        status, result, _ = self.call("POST", "create", task(audience="class", batch_id="25cs"), uid="teacher-token")
        self.assertEqual(status, 409)
        self.assertIn("Refresh", result["error"])
        self.assertNotIn("private enrollment details", result["error"])

    def test_settings_reject_owner_role_status_and_bad_fields(self):
        values = [settings(full_name="A"), settings(full_name="x" * 101), settings(roll_number=" "),
                  settings(roll_number="x" * 31), settings(roll_number="@roll"), settings(roll_number="01.2"), settings(division="D"), settings(class_code="26cs"),
                  settings(role="teacher"), settings(user_id=BOB), settings(status="approved"), settings(full_name="Bad\x00Name")]
        for value in values:
            self.assertEqual(self.call("PATCH", "settings", value)[0], 400, value)
        self.assertEqual(self.call("PATCH", "settings", settings(), identifier=BOB)[0], 400)
        self.assertEqual(self.call("PATCH", "settings", settings(), uid="teacher-token")[0], 403)
        self.assertEqual(self.call(action="settings", uid=None)[0], 401)

    def test_teacher_can_review_and_approve_but_students_cannot(self):
        self.assertEqual(self.call(action="enrollments")[0], 403)
        status, data, _ = self.call(action="enrollments", uid="teacher-token")
        self.assertEqual((status, data["role"]), (200, "teacher"))
        self.assertEqual([row["user_id"] for row in data["enrollments"]], [OUTSIDER])
        decision = {"student_id": OUTSIDER, "batch_id": "25CS", "approve": True, "expected_division": "C"}
        self.assertEqual(self.call("PATCH", "enrollment", decision)[0], 403)
        status, value, _ = self.call("PATCH", "enrollment", decision, uid="teacher-token")
        self.assertEqual((status, value), (200, {"updated": True, "status": "approved"}))
        self.assertEqual(self.call(action="enrollments", uid="teacher-token")[1]["enrollments"], [])

    def test_approval_checks_class_target_and_boolean(self):
        body = {"student_id": OUTSIDER, "batch_id": "26cs", "approve": True, "expected_division": "C"}
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 403)
        body["batch_id"] = "25cs"; body["student_id"] = str(uuid4())
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 404)
        body["student_id"] = OUTSIDER; body["approve"] = "true"
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 400)
        body["approve"] = True; body.pop("expected_division")
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 400)
        body["expected_division"] = "D"
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 400)
        body["expected_division"] = None; self.store.members[OUTSIDER]["division"] = None
        self.assertEqual(self.call("PATCH", "enrollment", body, uid="teacher-token")[0], 200)

    def test_stale_division_review_cannot_approve_changed_enrollment(self):
        reviewed = {"student_id": OUTSIDER, "batch_id": "25cs", "approve": True, "expected_division": "C"}
        self.store.members[OUTSIDER]["division"] = "B"
        status, value, _ = self.call("PATCH", "enrollment", reviewed, uid="teacher-token")
        self.assertEqual(status, 409)
        self.assertIn("Refresh", value["error"])
        self.assertEqual(self.store.members[OUTSIDER]["status"], "pending")
        reviewed["expected_division"] = " b "
        self.assertEqual(self.call("PATCH", "enrollment", reviewed, uid="teacher-token")[0], 200)
        self.assertEqual(self.store.members[OUTSIDER]["status"], "approved")

    def test_division_target_validation_and_specific_empty_roster_error(self):
        body = task(audience="division", batch_id="25CS", target_division=" a ")
        status, result, _ = self.call("POST", "create", body, uid="teacher-token")
        self.assertEqual(status, 201, result)
        self.assertEqual(self.store.last_create["target_division"], "A")
        self.assertEqual(self.store.last_create["batch_id"], "25cs")
        body["target_division"] = "C"
        status, result, _ = self.call("POST", "create", body, uid="teacher-token")
        self.assertEqual(status, 400)
        self.assertIn("No approved students", result["error"])
        self.assertIn("division", result["error"])
        body["target_division"] = "D"
        self.assertEqual(self.call("POST", "create", body, uid="teacher-token")[0], 400)
        self.assertEqual(self.call("POST", "create", task(target_division="A"))[0], 400)

    def test_empty_class_message_is_actionable_and_no_write_occurs(self):
        self.store.empty = True
        status, data, _ = self.call("POST", "create", task(audience="class", batch_id="25cs"), uid="teacher-token")
        self.assertEqual(status, 400)
        self.assertIn("Settings", data["error"])
        self.assertIn("approve", data["error"])
        self.assertFalse(self.store.rows)

    def test_database_empty_roster_allowlist_never_echoes_other_details(self):
        self.store.extra_error = {"code": "PT422", "message": "No approved students are enrolled in this division."}
        status, result, _ = self.call("POST", "create", task(audience="class", batch_id="25cs"), uid="teacher-token")
        self.assertEqual(status, 400)
        self.assertIn("division", result["error"])
        self.store.extra_error = {"code": "PT400", "message": "sb_secret_private database student id"}
        status, result, _ = self.call("POST", "create", task(audience="class", batch_id="25cs"), uid="teacher-token")
        self.assertEqual(status, 400)
        self.assertNotIn("sb_secret", result["error"])
        self.assertNotIn("student id", result["error"])


if __name__ == "__main__":
    unittest.main()
