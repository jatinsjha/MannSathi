import io
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from api import support
from api.shared.supabase import ApiError


class SupportTests(unittest.TestCase):
    def fields(self, **extra):
        return {"kind": "bug", "request_id": str(uuid4()), "detail": "Test calendar refresh", "email": "", **extra}

    def test_required_reply_for_privacy(self):
        with self.assertRaises(ApiError):
            support.fields(self.fields(kind="privacy"))
        self.assertIsNone(support.fields(self.fields())["p_email"])
        self.assertEqual(support.fields(self.fields(kind="privacy", email="member@example.test"))["p_email"], "member@example.test")

    def test_confirmed_private_reference(self):
        request=self.fields()
        with patch.object(support, "configuration", return_value=("https://example.supabase.co","public")), \
             patch.object(support, "_service_headers", return_value={"apikey":"secret"}), \
             patch.object(support._transport, "open", return_value=io.BytesIO(json.dumps(request["request_id"]).encode())) as call:
            self.assertEqual(support.submit(request,"192.0.2.10"), {"reference":request["request_id"]})
        sent=json.loads(call.call_args.args[0].data)
        self.assertEqual(len(sent["p_source"]),64)
        self.assertNotIn("192.0.2.10", str(sent))

    def test_unconfirmed_result(self):
        with patch.object(support, "configuration", return_value=("https://example.supabase.co","public")), \
             patch.object(support, "_service_headers", return_value={"apikey":"secret"}), \
             patch.object(support._transport, "open", return_value=io.BytesIO(b"null")):
            with self.assertRaises(ApiError) as cm:
                support.submit(self.fields(),"192.0.2.10")
            self.assertEqual(cm.exception.status,503)
