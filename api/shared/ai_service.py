"""Supabase access for trusted AI endpoints. Never return server credentials to callers."""
import base64
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from api.shared.supabase import ApiError, authenticate, configuration


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


_transport = build_opener(NoRedirect())


def configured_model():
    model = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite").strip().removeprefix("models/")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", model):
        raise ApiError(503, "The configured Gemini model is invalid.")
    return model


def verified_account(headers):
    """Always ask Supabase Auth to verify the bearer token, including its subject."""
    try:
        return authenticate(headers)
    except ApiError as exc:
        if exc.status in (401, 403):
            raise ApiError(exc.status, "Sign in with your MannSathi account to continue.") from None
        raise ApiError(503, "Sign-in verification is temporarily unavailable.") from None


def verified_user_id(headers):
    return verified_account(headers).user_id


def session_has_mfa(account):
    """Read the AAL of the same bearer that Supabase /auth/v1/user just verified."""
    try:
        header, payload, signature = account.token.split(".")
        if not header or not signature:
            return False
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return isinstance(claims, dict) and claims.get("sub") == account.user_id and claims.get("aal") == "aal2"
    except (ValueError, UnicodeError, TypeError):
        return False


def paid_pilot_configured():
    """An operator confirms Paid Services for this specific project/key pair."""
    project = os.environ.get("GEMINI_CLOUD_PROJECT", "").strip()
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    reviewed = os.environ.get("GEMINI_PAID_PROJECT_ATTESTATION", "").strip()
    until = os.environ.get("GEMINI_PAID_REVIEW_UNTIL", "").strip()
    if not key or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project) or not re.fullmatch(r"[0-9a-f]{64}", reviewed):
        return False
    try:
        expires = datetime.strptime(until, "%Y-%m-%d").date()
    except ValueError:
        return False
    today = datetime.now(timezone.utc).date()
    if not today <= expires <= today + timedelta(days=30):
        return False
    actual = hashlib.sha256((project + "\n" + key).encode()).hexdigest()
    return hmac.compare_digest(reviewed, actual)


def _server_key():
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if key.startswith("sb_secret_") and len(key) > len("sb_secret_"):
        return key
    try:
        header, claims, signature = key.split(".")
        payload = json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))
        if header and signature and isinstance(payload, dict) and payload.get("role") == "service_role":
            return key
    except (ValueError, TypeError, UnicodeError):
        pass
    raise ApiError(503, "AI usage storage requires a server-side Supabase credential.")


def rpc(name, payload):
    """Call a fixed AI RPC. Only legacy service-role JWTs belong in Authorization."""
    if not re.fullmatch(r"mannsathi_ai_[a-z_]+", name):
        raise ValueError("Invalid AI RPC")
    url, _ = configuration()
    key = _server_key()
    headers = {"apikey": key, "Accept": "application/json", "Content-Type": "application/json"}
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = "Bearer " + key
    request = Request(url + "/rest/v1/rpc/" + name, method="POST", headers=headers,
                      data=json.dumps(payload, allow_nan=False).encode("utf-8"))
    try:
        with _transport.open(request, timeout=12) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise ApiError(502, "This report is too large. Choose a shorter date range.")
            return json.loads(raw) if raw else None
    except HTTPError as exc:
        messages = {400: "Invalid AI management request.", 401: "Sign in with your MannSathi account.",
                    403: "Administrator access is required.",
                    404: "The requested record was not found.", 409: "The record has changed. Refresh and retry.",
                    413: "Export covers more than 10,000 requests. Narrow your filters.",
                    429: "Too many requests. Please try again shortly."}
        try:
            detail = json.loads(exc.read(2048))
            code = detail.get("code") if isinstance(detail, dict) else None
        except (ValueError, OSError):
            code = None
        if exc.code in messages and code == f"PT{exc.code}":
            raise ApiError(exc.code, messages[exc.code]) from None
        if name == "mannsathi_ai_report" and code == "25006":
            raise ApiError(503, "Supabase opened the AI report in a read-only transaction. "
                           "Check migration 009 and refresh the PostgREST schema cache.") from None
        raise ApiError(503, "AI usage storage is unavailable. Check the migrations and server configuration.") from None
    except (OSError, ValueError, URLError):
        raise ApiError(503, "AI usage storage could not be reached. Please retry.") from None
