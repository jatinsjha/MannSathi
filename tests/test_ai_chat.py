"""Chat entry-point tests using fake Gemini and Supabase transports, without private content in the ledger."""
import http.client
import hashlib
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from unittest.mock import patch
from uuid import UUID, uuid4

from api import chat
from api.shared import ai_service, supabase


ALICE = "00000000-0000-4000-8000-000000000001"
PRIVATE = "private student message"
UNKNOWN = {"p_input_tokens": None, "p_output_tokens": None, "p_total_tokens": None, "p_thought_tokens": None}


def stream(data):
    return io.BytesIO(json.dumps(data).encode())


class ChatTests(unittest.TestCase):
    def setUp(self):
        for p in (patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co",
                                             "SUPABASE_KEY": "sb_publishable_client",
                                             "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_server",
                                             "GEMINI_API_KEY": "test-google-key", "GEMINI_MODEL": "models/model-A",
                                             "GEMINI_CLOUD_PROJECT": "mannsathi-test",
                                             "GEMINI_PAID_REVIEW_UNTIL": datetime.now(timezone.utc).date().isoformat(),
                                             "GEMINI_PAID_PROJECT_ATTESTATION": hashlib.sha256(b"mannsathi-test\ntest-google-key").hexdigest()}),
                  patch.object(supabase, "urlopen", side_effect=self.auth),
                  patch.object(ai_service._transport, "open", side_effect=self.storage),
                  patch.object(chat._count_transport, "open", side_effect=self.count)):
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(chat, "generate")
        self.generate = p.start()
        self.addCleanup(p.stop)
        self.result = SimpleNamespace(text="Study plan", model_version="model-A-01", usage_metadata=SimpleNamespace(
            prompt_token_count=23, candidates_token_count=14, total_token_count=42, thoughts_token_count=5))
        self.generate.return_value = self.result
        self.rows = {}
        self.calls = []
        self.count_calls = []
        self.count_result = {"totalTokens": 23}
        self.anonymous = False
        self.deny_admission = self.deny_resize = None
        self.finish_lost = 0
        self.request_id = str(uuid4())
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), chat.handler)
        worker = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def auth(self, request, timeout):
        self.assertTrue(request.full_url.endswith("/auth/v1/user"))
        self.assertEqual(request.get_header("Apikey"), "sb_publishable_client")
        if request.get_header("Authorization") != "Bearer verified":
            raise HTTPError(request.full_url, 401, "Unauthorized", {}, stream({}))
        return stream({"id": ALICE, "is_anonymous": self.anonymous, "user_metadata": {"role": "admin"}})

    def storage(self, request, timeout):
        self.assertEqual(request.get_header("Apikey"), "sb_secret_server")
        self.assertIsNone(request.get_header("Authorization"))
        action = request.full_url.split("mannsathi_ai_")[1]
        data = json.loads(request.data)
        self.assertNotIn(PRIVATE, str(data))
        self.assertNotIn("test-google-key", str(data))
        self.calls.append((action, data))
        if action == "pilot_eligible":
            return stream(self.deny_admission is None)
        rid = data["p_request_id"]
        if action == "pilot_reserve":
            if rid in self.rows:
                return stream({"allowed": False, "code": "duplicate"})
            self.rows[rid] = {"status": "pending", **data}
            if self.deny_admission:
                return stream({"allowed": False, "code": self.deny_admission})
        elif action == "pilot_resize":
            if self.deny_resize:
                return stream({"allowed": False, "code": self.deny_resize})
        elif action == "finish":
            self.rows[rid].update(data)
            if self.finish_lost > 0:
                self.finish_lost -= 1
                raise URLError("sensitive transport details")
            return stream({"recorded": True})
        else:
            self.fail("Unexpected storage function " + action)
        return stream({"allowed": True})

    def count(self, request, timeout):
        self.assertEqual(request.full_url, "https://generativelanguage.googleapis.com/v1beta/models/model-A:countTokens")
        self.assertEqual(request.get_header("X-goog-api-key"), "test-google-key")
        self.count_calls.append(json.loads(request.data)["generateContentRequest"])
        return stream(self.count_result)

    def send(self, body=None, token="Bearer verified", content_type="application/json"):
        headers = {"Content-Type": content_type}
        if token is not None:
            headers["Authorization"] = token
        if body is None:
            body = {"request_id": self.request_id, "messages": [{"role": "user", "text": PRIVATE}]}
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        conn.request("POST", "/api/chat", json.dumps(body).encode(), headers)
        response = conn.getresponse()
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_verified_identity_prompt_reservation_and_measured_usage(self):
        self.assertEqual(self.send(), (200, {"reply": "Study plan", "request_id": self.request_id}))
        self.assertEqual([action for action, _ in self.calls], ["pilot_reserve", "pilot_resize", "finish"])
        self.assertEqual(self.calls[0][1]["p_user_id"], ALICE)
        self.assertEqual(self.calls[0][1]["p_reserved_tokens"], 1)
        self.assertEqual(self.calls[1][1]["p_reserved_tokens"], 23 + 1024)
        self.assertEqual(self.count_calls[0]["systemInstruction"]["parts"][0]["text"], chat.SYSTEM_INSTRUCTION)
        self.assertEqual(self.count_calls[0]["contents"], self.generate.call_args.args[2])
        self.assertEqual(self.count_calls[0]["generationConfig"]["maxOutputTokens"], 1024)
        self.assertEqual(self.count_calls[0]["model"], "models/model-A")
        row = self.rows[self.request_id]
        self.assertEqual([row[k] for k in UNKNOWN], [23, 14, 42, 5])
        self.assertEqual((row["p_model"], row["p_reported_model"], row["p_feature"]), ("model-A", "model-A-01", "chat"))
        self.assertIs(row["p_generation_attempted"], True)
        self.assertEqual((row["p_status"], row["p_error_category"]), ("success", None))

    def test_missing_usage_is_never_zero_or_the_preflight_value(self):
        self.result.usage_metadata = None
        self.assertEqual(self.send()[0], 200)
        row = self.rows[self.request_id]
        self.assertEqual({key: row[key] for key in UNKNOWN}, UNKNOWN)
        invalid = SimpleNamespace(usage_metadata=SimpleNamespace(prompt_token_count=5, candidates_token_count=True,
                                                                 total_token_count=2, thoughts_token_count=-1))
        self.assertEqual(chat.provider_usage(invalid), {**UNKNOWN, "p_input_tokens": 5})
        self.assertEqual(chat.provider_usage(SimpleNamespace(usage_metadata=SimpleNamespace(
            candidates_token_count=0)))["p_output_tokens"], 0)

    def test_failed_and_empty_response_recorded_without_exception_text(self):
        self.generate.side_effect = HTTPError("https://example.test/", 429, "private-key-server", {}, None)
        status, error = self.send()
        self.assertEqual(status, 429)
        self.assertNotIn("private-key-server", str(error))
        row = self.rows[self.request_id]
        self.assertEqual((row["p_error_category"], row["p_status"], row["p_total_tokens"]), ("provider_rate_limit", "failed", None))
        self.assertIs(row["p_generation_attempted"], True)
        self.request_id = str(uuid4())
        self.generate.side_effect = None
        self.result.text = " "
        self.assertEqual(self.send()[0], 502)
        row = self.rows[self.request_id]
        self.assertEqual((row["p_error_category"], row["p_total_tokens"]), ("provider_empty", 42))

    def test_duplicate_and_user_initiated_retry_have_distinct_accounting(self):
        self.assertEqual(self.send()[0], 200)
        self.assertEqual(self.send()[0], 409)
        self.generate.assert_called_once()
        other = str(uuid4())
        status, _ = self.send({"request_id": other, "retry_of": self.request_id,
                               "messages": [{"role": "user", "text": PRIVATE}]})
        self.assertEqual((status, self.rows[other]["p_retry_of"], len(self.rows)), (200, self.request_id, 2))

    def test_ambiguous_finalization_retries_the_same_measurements_without_regeneration(self):
        self.finish_lost = 1
        self.assertEqual(self.send()[0], 200)
        self.assertEqual(self.calls[-1], self.calls[-2])
        self.generate.assert_called_once()
        self.assertEqual(self.send()[0], 409)

    def test_guests_and_invalid_or_unapproved_accounts_cannot_dispatch(self):
        status, body = self.send(token=None)
        self.assertEqual((status, body["code"]), (403, "ai_unavailable"))
        self.assertFalse(self.calls)
        self.assertFalse(self.count_calls)
        self.assertEqual(self.send(token="Bearer expired")[0], 401)
        self.assertEqual(self.send(token="")[0], 401)
        self.anonymous = True
        self.assertEqual(self.send()[0], 403)
        self.anonymous = False
        self.deny_admission = "ai_unavailable"
        self.assertEqual(self.send()[0], 403)
        self.assertEqual(len(self.calls), 1)
        self.generate.assert_not_called()

    def test_capability_and_project_bound_billing_attestation(self):
        def capability(token):
            conn = http.client.HTTPConnection("127.0.0.1",self.httpd.server_port,timeout=5)
            conn.request("GET","/api/chat",headers={"Authorization":"Bearer "+token} if token else {})
            res=conn.getresponse()
            result=res.status,json.loads(res.read())
            conn.close()
            return result
        self.assertEqual(capability(None),(200,{"available":False}))
        self.assertEqual(capability("verified"),(200,{"available":True}))
        self.assertEqual(capability("expired")[0],401)
        self.deny_admission="ai_unavailable"
        self.assertEqual(capability("verified"),(200,{"available":False}))
        self.calls.clear()
        for changed in ({"GEMINI_PAID_PROJECT_ATTESTATION":""},{"GEMINI_API_KEY":"rotated"},
                        {"GEMINI_CLOUD_PROJECT":"another-project"},{"GEMINI_PAID_REVIEW_UNTIL":"2000-01-01"},
                        {"GEMINI_PAID_REVIEW_UNTIL":"2099-01-01"}):
            with patch.dict("os.environ",changed):
                self.assertEqual(capability("verified"),(200,{"available":False}))
                self.assertEqual(self.send()[0],503)
        self.assertFalse(self.calls)
        self.assertFalse(self.count_calls)

    def test_disabled_and_daily_monthly_caps_prevent_generation(self):
        self.deny_admission = "student_restricted"
        self.assertEqual(self.send()[0], 403)
        self.assertFalse(self.count_calls)
        self.deny_admission = None
        for limit in ("student_daily", "student_monthly", "global_daily", "global_monthly"):
            self.request_id, self.deny_resize = str(uuid4()), limit
            self.assertEqual(self.send()[0], 429)
        self.generate.assert_not_called()
        self.deny_resize = None
        self.request_id = str(uuid4())
        self.assertEqual(self.send()[0], 200)

    def test_identification_forgery_and_bad_body_rejected(self):
        for body in ({"user_id": str(uuid4()), "messages": [{"role": "user", "text": "hello"}]},
                     {"request_id": 123}, {"messages": [{"role": "model", "text": "test"}]},
                     {"messages": [{"role": "user", "text": "\udc80"}]}, {"messages": []}, "text", []):
            self.assertEqual(self.send(body)[0], 400)
        self.assertEqual(self.send(content_type="text/plain")[0], 415)
        self.assertFalse(self.calls)
        status, payload = self.send({"messages": [{"role": "user", "text": "legacy caller"}]})
        self.assertEqual(status, 200)
        UUID(payload["request_id"])

    def test_bad_count_and_unconfigured_provider(self):
        self.count_result = {"totalTokens": True}
        self.assertEqual(self.send()[0], 502)
        self.assertEqual(self.rows[self.request_id]["p_error_category"], "provider_error")
        self.assertIs(self.rows[self.request_id]["p_generation_attempted"], False)
        self.generate.assert_not_called()
        self.request_id = str(uuid4())
        with patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            self.assertEqual(self.send()[0], 503)
        self.assertNotIn(self.request_id,self.rows)

    def test_missing_storage_or_privileged_backend_key_fails_closed(self):
        with patch.dict("os.environ", {"SUPABASE_SERVICE_ROLE_KEY": "sb_publishable_client"}):
            self.assertEqual(self.send()[0], 503)
        with patch.object(ai_service._transport, "open", side_effect=URLError("secret-host-details")):
            status, payload = self.send()
            self.assertEqual(status, 503)
            self.assertNotIn("secret-host-details", str(payload))
        self.assertFalse(self.count_calls)
        self.generate.assert_not_called()

    def test_only_pre_generation_failures_can_release_the_token_reservation(self):
        with patch.object(chat._count_transport, "open", side_effect=HTTPError("https://example.test/", 429, "", {}, None)):
            self.assertEqual(self.send()[0], 429)
        row = self.rows[self.request_id]
        self.assertEqual((row["p_error_category"], row["p_generation_attempted"]), ("provider_rate_limit", False))
        self.request_id = str(uuid4())
        def interrupted_resize(name, data):
            if name == "mannsathi_ai_pilot_resize":
                raise supabase.ApiError(503, "Storage unavailable.")
            return ai_service.rpc(name, data)
        with patch.object(chat, "rpc", side_effect=interrupted_resize):
            self.assertEqual(self.send()[0], 503)
        row = self.rows[self.request_id]
        self.assertEqual((row["p_error_category"], row["p_generation_attempted"]), ("usage_storage", False))
        self.generate.assert_not_called()
        self.request_id = str(uuid4())
        self.generate.side_effect = TimeoutError()
        self.assertEqual(self.send()[0], 504)
        row = self.rows[self.request_id]
        self.assertEqual((row["p_error_category"], row["p_generation_attempted"]), ("provider_timeout", True))


class GeminiSDKContract(unittest.TestCase):
    def test_real_sdk_encodes_counted_prompt_reads_metadata_and_sends_one_attempt(self):
        try:
            from google import genai
        except ImportError:
            self.skipTest("Install the project requirements to run the SDK wire contract.")
        calls = []

        class Fixture(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                if len(calls) == 1:
                    status = 200
                    data = {"candidates": [{"content": {"role": "model", "parts": [{"text": "Reply"}]},
                                            "finishReason": "STOP"}], "modelVersion": "model-A-01",
                            "usageMetadata": {"promptTokenCount": 13, "candidatesTokenCount": 5,
                                              "thoughtsTokenCount": 2, "totalTokenCount": 20}}
                else:
                    status, data = 429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "busy"}}
                raw = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        local = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        worker = threading.Thread(target=local.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(local.server_close)
        self.addCleanup(local.shutdown)
        content = [{"role": "user", "parts": [{"text": "Hello"}]}]
        with patch.dict("os.environ", {"GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{local.server_port}",
                                       "NO_PROXY": "127.0.0.1"}):
            reply = chat.generate("test-key", "model-A", content)
            with self.assertRaises(genai.errors.APIError) as caught:
                chat.generate("test-key", "model-A", content)
        self.assertEqual(chat.provider_failure(caught.exception)[0], "provider_rate_limit")
        self.assertEqual(len(calls), 2)
        path, payload = calls[0]
        self.assertEqual(path, "/v1beta/models/model-A:generateContent")
        self.assertEqual(payload["contents"], content)
        self.assertEqual(payload["systemInstruction"], chat.SYSTEM_CONTENT)
        self.assertEqual(payload["generationConfig"]["maxOutputTokens"], chat.MAX_OUTPUT_TOKENS)
        self.assertEqual(reply.text, "Reply")
        self.assertEqual(chat.provider_usage(reply), {"p_input_tokens": 13, "p_output_tokens": 5,
                                                     "p_total_tokens": 20, "p_thought_tokens": 2})


if __name__ == "__main__":
    unittest.main()
