"""Use a user's verified Supabase token, preserving Row Level Security."""
import base64
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import UUID


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def browser_safe_key(key):
    """Check key type only; this is never used to verify a user's identity."""
    if not isinstance(key, str):
        return False
    if key.startswith("sb_publishable_"):
        return len(key) > len("sb_publishable_")
    try:
        parts = key.split(".")
        if len(parts) != 3 or not all(parts):
            return False
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return isinstance(payload, dict) and payload.get("role") == "anon"
    except (ValueError, TypeError, UnicodeError):
        return False


def configuration():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_KEY", "")
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path
            or not browser_safe_key(key)):
        raise ApiError(503, "Supabase requires a valid URL and browser-safe publishable or anon key.")
    return url, key


def request_json(url, key, token, method="GET", payload=None, prefer=None, auth=False):
    headers = {"apikey": key, "Authorization": "Bearer " + token,
               "Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload, allow_nan=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    try:
        with urlopen(Request(url, data=data, headers=headers, method=method), timeout=12) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise ApiError(502, "Calendar response is too large. Try a shorter date range.")
            return json.loads(raw) if raw else None
    except HTTPError as exc:
        # Do not forward upstream details, identifiers, or configuration secrets.
        if exc.code == 401 or (auth and exc.code in (400, 403)):
            raise ApiError(401, "Please sign in again to use your calendar.") from None
        if exc.code == 403:
            raise ApiError(403, "Calendar access was denied. Check the calendar access policies.") from None
        if exc.code in (404, 400):
            raise ApiError(503, "Calendar storage is unavailable. Check the calendar migration and configuration.") from None
        if exc.code == 409:
            raise ApiError(409, "This event could not be saved. Refresh your calendar and try again.") from None
        if exc.code == 429:
            raise ApiError(429, "Too many calendar requests. Please try again shortly.") from None
        raise ApiError(502, "Calendar service is temporarily unavailable. Please retry.") from None
    except (URLError, TimeoutError, OSError, ValueError, UnicodeError):
        raise ApiError(502, "Calendar service could not be reached. Please retry.") from None


def authenticate(headers):
    value = headers.get("Authorization", "")
    parts = value.split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or len(parts[1]) > 8192:
        raise ApiError(401, "Sign in to use your personal calendar.")
    url, key = configuration()
    token = parts[1]
    user = request_json(url + "/auth/v1/user", key, token, auth=True)
    try:
        user_id = str(UUID(user["id"]))
    except (TypeError, KeyError, ValueError, AttributeError):
        raise ApiError(401, "Please sign in again to use your calendar.") from None
    if user.get("is_anonymous") is True:
        raise ApiError(403, "Sign in with your student account to use the calendar.")
    return SupabaseUser(url, key, token, user_id)


class SupabaseUser:
    def __init__(self, url, key, token, user_id):
        self.url, self.key, self.token, self.user_id = url, key, token, user_id

    def events(self, method="GET", query=None, payload=None):
        filters = {"user_id": "eq." + self.user_id, **(query or {})}
        url = self.url + "/rest/v1/calendar_events?" + urlencode(filters)
        result = request_json(url, self.key, self.token, method, payload,
                              prefer="return=representation" if method != "GET" else None)
        if not isinstance(result, list):
            raise ApiError(502, "Calendar service returned an invalid response. Please retry.")
        # RLS and query filters are authoritative. This also fails closed on bad responses.
        if any(not isinstance(event, dict) or event.get("user_id") != self.user_id for event in result):
            raise ApiError(502, "Calendar service returned an invalid response. Please retry.")
        return result
