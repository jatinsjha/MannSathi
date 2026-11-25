"""Private student subjects, timestamp-based Pomodoro sessions and study totals."""
import json
import math
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

from api.shared import supabase
from api.shared.supabase import ApiError, authenticate
from api.shared.focus_validation import history_range, identifier, prefs_payload, start_payload, subject_payload, timezone

CONFLICTS = {
    "An active subject already has that name": "An active subject already has that name. Choose another name or edit that subject.",
    "You can keep up to 100 active subjects": "You can keep up to 100 active subjects. Archive an unused subject first.",
    "End the active session before archiving its subject": "End the active session before archiving its subject.",
    "A focus session is already active": "A focus session is already active. Continue or end it before starting another.",
    "This session ID was already used for a different session": "This session ID was already used. Refresh your timer before retrying.",
    "The focus interval is not finished yet": "The focus interval is not finished yet. Continue it or end it early.",
}


def send_json(request, status, payload):
    raw = json.dumps(payload, allow_nan=False).encode("utf-8")
    request.send_response(status)
    request.send_header("Content-Type", "application/json; charset=utf-8")
    request.send_header("Content-Length", str(len(raw)))
    request.send_header("Cache-Control", "no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    if status == 405:
        request.send_header("Allow", "GET, POST, PATCH")
    request.end_headers()
    request.wfile.write(raw)


def body_json(request):
    if request.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "Send focus changes as JSON.")
    try:
        size = int(request.headers.get("Content-Length", "0"))
    except ValueError:
        raise ApiError(400, "Invalid focus request size.") from None
    if not 0 < size <= 16000:
        raise ApiError(400, "Invalid focus request size.")
    def reject_constant(value):
        raise ValueError("Invalid JSON number")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result
    try:
        value = json.loads(request.rfile.read(size), parse_constant=reject_constant, object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError("Focus request must be an object")
        return value
    except (ValueError, UnicodeError):
        raise ApiError(400, "Send a valid JSON focus request.") from None


def rpc(user, name, payload=None):
    """Use the verified original JWT; SQL repeats student and owner checks."""
    request = Request(user.url + "/rest/v1/rpc/mannsathi_focus_" + name,
                      data=json.dumps(payload or {}, allow_nan=False).encode("utf-8"),
                      headers={"apikey": user.key, "Authorization": "Bearer " + user.token,
                               "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    try:
        with supabase.urlopen(request, timeout=12) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise ApiError(502, "Focus response is too large. Please try a shorter history range.")
            return json.loads(raw)
    except HTTPError as exc:
        detail = {}
        try:
            detail = json.loads(exc.read(65536))
            code = detail.get("code") if isinstance(detail, dict) else None
        except (ValueError, OSError):
            code = None
        if code == "PT404":
            raise ApiError(404, "This subject, task, or focus session is unavailable.") from None
        if code == "PT403":
            raise ApiError(403, "Focus is available to student accounts only.") from None
        if code == "PT409":
            message = CONFLICTS.get(detail.get("message")) if isinstance(detail, dict) else None
            raise ApiError(409, message or "Your focus session changed. Refresh before retrying.") from None
        if code in {"PT400", "PT422", "23514", "22007", "22P02"}:
            raise ApiError(400, "This focus change is invalid. Check its fields and subject.") from None
        if exc.code == 401 or code == "PT401":
            raise ApiError(401, "Please sign in again to use Focus.") from None
        if exc.code == 403:
            raise ApiError(403, "Focus access was denied. Check your account permissions.") from None
        if exc.code in (400, 404) or code in {"PGRST202", "42P01", "42883"}:
            raise ApiError(503, "Focus storage is unavailable. Check the Focus migration and configuration.") from None
        if exc.code == 409:
            raise ApiError(409, "Your focus data changed. Refresh before retrying.") from None
        if exc.code == 429:
            raise ApiError(429, "Too many focus requests. Please try again shortly.") from None
        raise ApiError(502, "Focus service is temporarily unavailable. Please retry.") from None
    except (URLError, TimeoutError, OSError, ValueError, UnicodeError):
        raise ApiError(502, "Could not reach your focus data. Please retry.") from None


def unconfirmed():
    raise ApiError(502, "Focus service did not confirm your data. Refresh before retrying.")


def checked_subject(value, user, subject_id=None):
    if not isinstance(value, dict) or value.get("user_id") != user.user_id or subject_id and value.get("id") != subject_id:
        unconfirmed()
    try:
        identifier(value.get("id"))
        subject_payload({key: value.get(key) for key in ("name", "color", "weekly_goal_minutes", "archived")}, edit=True)
    except ApiError:
        unconfirmed()
    return value


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def checked_session(value, user, session_id=None):
    if not isinstance(value, dict) or value.get("user_id") != user.user_id or session_id and value.get("id") != session_id:
        unconfirmed()
    try:
        identifier(value.get("id")); identifier(value.get("subject_id"))
    except ApiError:
        unconfirmed()
    if (value.get("status") not in {"running", "paused", "completed", "interrupted", "cancelled"}
            or not number(value.get("focused_seconds")) or not number(value.get("remaining_seconds"))
            or type(value.get("planned_seconds")) is not int or not 60 <= value["planned_seconds"] <= 10800
            or value["focused_seconds"] > value["planned_seconds"]):
        unconfirmed()
    return value


def checked_prefs(value):
    try:
        return prefs_payload(value)
    except ApiError:
        unconfirmed()


def checked_transition(value, user, session_id):
    if not isinstance(value, dict) or not isinstance(value.get("server_now"), str):
        unconfirmed()
    checked_session(value.get("session"), user, session_id)
    return value


def dispatch(request, method):
    try:
        if method not in {"GET", "POST", "PATCH"}:
            raise ApiError(405, "Use GET, POST, or PATCH for focus.")
        user = authenticate(request.headers)
        raw = parse_qs(urlsplit(request.path).query, keep_blank_values=True)
        if any(len(values) != 1 for values in raw.values()):
            raise ApiError(400, "Send each focus query parameter once.")
        query = {key: values[0] for key, values in raw.items()}
        action = query.get("action", "state" if method == "GET" else "")
        allowed = {"action", "time_zone", "start", "end"} if action == "history" and method == "GET" else (
            {"action", "time_zone"} if action == "summary" and method == "GET" else
            {"action", "id"} if method == "PATCH" and action != "prefs" else {"action"})
        if set(query) - allowed:
            raise ApiError(400, "Unsupported focus query parameter.")
        if method == "GET" and action == "subjects":
            result = rpc(user, "subjects")
            if not isinstance(result, dict) or result.get("role") != "student" or not isinstance(result.get("subjects"), list):
                unconfirmed()
            for item in result["subjects"]:
                checked_subject(item, user)
            send_json(request, 200, result)
        elif method == "GET" and action == "state":
            result = rpc(user, "state")
            if not isinstance(result, dict) or not isinstance(result.get("server_now"), str):
                unconfirmed()
            checked_prefs(result.get("prefs"))
            for key in ("active", "finished"):
                if result.get(key) is not None:
                    checked_session(result[key], user)
            send_json(request, 200, result)
        elif method == "GET" and action == "summary":
            result = rpc(user, "summary", {"p_time_zone": timezone(query.get("time_zone"))})
            if (not isinstance(result, dict) or any(not number(result.get(key)) for key in
                    ("total_seconds", "today_seconds", "week_seconds", "completed_sessions")) or
                    any(not isinstance(result.get(key), list) for key in ("subjects", "daily", "history"))):
                unconfirmed()
            for item in result["history"]:
                checked_session(item, user)
            send_json(request, 200, result)
        elif method == "GET" and action == "history":
            payload = history_range(query)
            rows = []
            for offset in range(0, 10001, 500):
                page = rpc(user, "history", {**payload, "p_offset": offset, "p_limit": 500})
                if not isinstance(page, list):
                    unconfirmed()
                for item in page:
                    checked_session(item, user)
                rows.extend(page)
                if len(rows) > 10000:
                    raise ApiError(400, "Too many focus sessions to load. Choose a shorter history range.")
                if len(page) < 500:
                    send_json(request, 200, {"history": rows})
                    return
            raise ApiError(400, "Too many focus sessions to load. Choose a shorter history range.")
        elif method in {"POST", "PATCH"} and action == "subject":
            subject_id = identifier(query.get("id")) if method == "PATCH" else None
            payload = {"p_data": subject_payload(body_json(request), edit=method == "PATCH")}
            if subject_id:
                payload["p_id"] = subject_id
            result = rpc(user, "edit_subject" if subject_id else "create_subject", payload)
            if not isinstance(result, dict):
                unconfirmed()
            checked_subject(result.get("subject"), user, subject_id)
            send_json(request, 200 if subject_id else 201, result)
        elif method == "POST" and action == "start":
            payload = start_payload(body_json(request))
            result = checked_transition(rpc(user, "start", payload), user, payload["p_session_id"])
            send_json(request, 201, result)
        elif method == "PATCH" and action == "prefs":
            result = rpc(user, "save_prefs", {"p_data": prefs_payload(body_json(request))})
            if not isinstance(result, dict):
                unconfirmed()
            checked_prefs(result.get("prefs"))
            send_json(request, 200, result)
        elif method == "PATCH" and action in {"pause", "resume", "finish", "interrupt", "cancel"}:
            session_id = identifier(query.get("id"))
            if body_json(request):
                raise ApiError(400, "The server measures elapsed time. Timer actions cannot supply other fields.")
            result = checked_transition(rpc(user, "transition", {"p_id": session_id, "p_action": action}), user, session_id)
            send_json(request, 200, result)
        else:
            raise ApiError(400, "Choose a valid focus action.")
    except ApiError as exc:
        send_json(request, exc.status, {"error": exc.message.replace("calendar", "focus").replace("Calendar", "Focus")})
    except (BrokenPipeError, ConnectionResetError):
        return
    except Exception:
        send_json(request, 500, {"error": "Could not process your focus request. Please retry."})


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        dispatch(self, "GET")

    def do_POST(self):
        dispatch(self, "POST")

    def do_PATCH(self):
        dispatch(self, "PATCH")

    def do_DELETE(self):
        dispatch(self, "DELETE")

    def do_PUT(self):
        dispatch(self, "PUT")

    def log_message(self, format, *args):
        return
