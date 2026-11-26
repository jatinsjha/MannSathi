"""Server-only transport for the fixed set of MannSathi AI database functions."""
import base64
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from api.shared.supabase import ApiError, configuration


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_open = build_opener(_NoRedirect()).open
_RPCS = {"ai_admin_gate", "ai_change_policy", "ai_admit", "ai_finish", "ai_report"}
_MESSAGES = {
    "PT400": (400, "Check the supplied fields, limits and dates."),
    "PT403": (403, "Administrator access is required."),
    "PT404": (404, "The requested record is unavailable."),
    "PT409": (409, "This request conflicts with an existing record."),
    "PT422": (422, "The request exceeds the supported limits."),
    "PT429": (429, "Too many requests. Please try again shortly."),
}


def _service_headers():
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    headers = {"Content-Type": "application/json", "Accept": "application/json", "apikey": key}
    if key.startswith("sb_secret_") and len(key) > len("sb_secret_"):
        return headers
    try:
        first, payload, signature = key.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if first and signature and claims.get("role") == "service_role":
            headers["Authorization"] = "Bearer " + key
            return headers
    except (ValueError, UnicodeError, AttributeError):
        pass
    raise ApiError(503, "AI management requires a server-side Supabase secret key.")


def service_rpc(name, payload):
    if name not in _RPCS:
        raise ValueError("Unknown AI database function")
    url, _ = configuration()
    request = Request(url + "/rest/v1/rpc/" + name,
                      data=json.dumps(payload, allow_nan=False).encode("utf-8"),
                      headers=_service_headers(), method="POST")
    try:
        with _open(request, timeout=12) as response:
            raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise ApiError(422, "Choose a shorter date range for this report.")
            return json.loads(raw)
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read(32768))
            code = detail.get("code") if isinstance(detail, dict) else None
        except (ValueError, OSError):
            code = None
        if code in _MESSAGES:
            raise ApiError(*_MESSAGES[code]) from None
        if code in {"22003", "22007", "22008", "22P02", "23514", "23502"}:
            raise ApiError(400, "Check the supplied fields, limits and dates.") from None
        if exc.code == 429:
            raise ApiError(429, "AI management is busy. Please try again shortly.") from None
        raise ApiError(503, "AI storage is unavailable. Check the server configuration and migrations.") from None
    except (URLError, TimeoutError, OSError, ValueError, UnicodeError):
        raise ApiError(503, "AI storage could not be reached. Please retry.") from None
