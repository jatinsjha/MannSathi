"""Personal calendar CRUD. Supabase remains the only data store."""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from api.shared.supabase import ApiError, authenticate
from api.shared.validation import date_range, event_payload, identifier

SELECT = ("id,user_id,title,description,category,location,all_day,starts_at,ends_at,"
          "start_date,end_date,time_zone,reminder_minutes,created_at,updated_at")


def send_json(request, status, payload):
    raw = json.dumps(payload, allow_nan=False).encode("utf-8")
    request.send_response(status)
    request.send_header("Content-Type", "application/json; charset=utf-8")
    request.send_header("Content-Length", str(len(raw)))
    request.send_header("Cache-Control", "no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    if status == 405:
        request.send_header("Allow", "GET, POST, PATCH, DELETE")
    request.end_headers()
    request.wfile.write(raw)


def reject_constant(value):
    raise ValueError("Non-finite JSON value")


def body_json(request):
    if request.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "Send calendar events as JSON.")
    try:
        size = int(request.headers.get("Content-Length", "0"))
    except ValueError:
        raise ApiError(400, "Invalid calendar request size.") from None
    if not 0 < size <= 32000:
        raise ApiError(400, "Invalid calendar request size.")
    try:
        return json.loads(request.rfile.read(size), parse_constant=reject_constant)
    except (ValueError, UnicodeError):
        raise ApiError(400, "Send a valid JSON calendar event.") from None


def dispatch(request, method):
    try:
        if method not in {"GET", "POST", "PATCH", "DELETE"}:
            raise ApiError(405, "Use GET, POST, PATCH, or DELETE for calendar events.")
        user = authenticate(request.headers)
        raw_query = parse_qs(urlsplit(request.path).query, keep_blank_values=True)
        if any(len(values) != 1 for values in raw_query.values()):
            raise ApiError(400, "Send each calendar query parameter once.")
        query = {key: value[0] for key, value in raw_query.items()}
        allowed = {"start", "end", "time_zone"} if method == "GET" else {"id"} if method in {"PATCH", "DELETE"} else set()
        if set(query) - allowed:
            raise ApiError(400, "Unsupported calendar query parameter.")
        if method == "GET":
            filters = {**date_range(query), "select": SELECT,
                       "order": "start_date.asc.nullslast,starts_at.asc.nullslast,id.asc", "limit": "500"}
            events = []
            for offset in range(0, 10001, 500):
                page = user.events(query={**filters, "offset": str(offset)})
                events.extend(page)
                if len(events) > 10000:
                    raise ApiError(400, "Too many events in this date range. Choose a shorter range.")
                if len(page) < 500:
                    send_json(request, 200, {"events": events})
                    return
            raise ApiError(400, "Too many events in this date range. Choose a shorter range.")
        if method == "POST":
            payload = {**event_payload(body_json(request)), "user_id": user.user_id}
            result = user.events("POST", {"select": SELECT}, payload)
            if len(result) != 1:
                raise ApiError(502, "Calendar service returned an invalid save response.")
            send_json(request, 201, {"event": result[0]})
            return
        event_id = identifier(query.get("id"))
        filters = {"id": "eq." + event_id, "select": SELECT}
        payload = event_payload(body_json(request)) if method == "PATCH" else None
        result = user.events(method, filters, payload)
        if not result:
            raise ApiError(404, "This calendar event is unavailable. Refresh your calendar.")
        if len(result) != 1:
            raise ApiError(502, "Calendar service returned an invalid save response.")
        send_json(request, 200, {"event": result[0]} if method == "PATCH" else {"deleted": True})
    except ApiError as exc:
        send_json(request, exc.status, {"error": exc.message})
    except (BrokenPipeError, ConnectionResetError):
        return
    except Exception:
        # Never put upstream credentials or event content in logs or responses.
        send_json(request, 500, {"error": "Could not process your calendar request. Please retry."})


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
