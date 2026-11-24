"""Authenticated personal tasks, teacher assignments, and student notifications."""
import json
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

from api.shared import supabase
from api.shared.supabase import ApiError, authenticate
from api.shared.tasks_validation import create_payload, fields, identifier, status_payload


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


def body_json(request):
    if request.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "Send task changes as JSON.")
    try:
        size = int(request.headers.get("Content-Length", "0"))
    except ValueError:
        raise ApiError(400, "Invalid task request size.") from None
    if not 0 < size <= 32000:
        raise ApiError(400, "Invalid task request size.")
    def reject_constant(value):
        raise ValueError("Invalid JSON number")
    try:
        value = json.loads(request.rfile.read(size), parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError("Task request must be an object")
        return value
    except (ValueError, UnicodeError):
        raise ApiError(400, "Send a valid JSON task request.") from None


def rpc(user, name, payload=None):
    """Preserve the verified user's JWT. The RPC repeats ownership/class checks in SQL."""
    request = Request(user.url + "/rest/v1/rpc/mannsathi_task_" + name,
                      data=json.dumps(payload or {}, allow_nan=False).encode("utf-8"),
                      headers={"apikey": user.key, "Authorization": "Bearer " + user.token,
                               "Content-Type": "application/json", "Accept": "application/json"},
                      method="POST")
    try:
        with supabase.urlopen(request, timeout=12) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise ApiError(502, "Task response is too large. Please try again later.")
            return json.loads(raw)
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read(65536))
            code = detail.get("code") if isinstance(detail, dict) else None
        except (ValueError, OSError):
            code = None
        # Never return database messages, identifiers, event content, or secrets.
        if code == "PT404":
            raise ApiError(404, "This task or notification is unavailable.") from None
        if code == "PT403":
            raise ApiError(403, "You do not have permission for this task, student, or class.") from None
        if code == "PT400" or code in {"23514", "22007", "22P02"}:
            raise ApiError(400, "This task change is invalid. Check its fields and recipients.") from None
        if exc.code == 401 or code == "PT401":
            raise ApiError(401, "Please sign in again to use tasks.") from None
        if exc.code == 403:
            raise ApiError(403, "Task access was denied. Check your account permissions.") from None
        if exc.code in (400, 404) or code in {"PGRST202", "42P01", "42883"}:
            raise ApiError(503, "Task storage is unavailable. Check the task migration and configuration.") from None
        if exc.code == 409:
            raise ApiError(409, "The task changed while you were editing. Refresh and try again.") from None
        if exc.code == 429:
            raise ApiError(429, "Too many task requests. Please try again shortly.") from None
        raise ApiError(502, "Task service is temporarily unavailable. Please retry.") from None
    except (URLError, TimeoutError, OSError, ValueError, UnicodeError):
        raise ApiError(502, "Could not reach your tasks. Please retry.") from None


def context(user):
    result = rpc(user, "context")
    if (not isinstance(result, dict) or result.get("role") not in {"student", "teacher"}
            or result.get("user_id") != user.user_id
            or not isinstance(result.get("batches"), list) or not isinstance(result.get("students"), list)):
        raise ApiError(502, "Account permissions could not be verified. Please retry.")
    return result


def checked_task(result, task_id=None, owner=None):
    if not isinstance(result, dict):
        raise ApiError(502, "Task service did not confirm your change. Refresh before retrying.")
    try:
        identifier(result.get("id"))
    except ApiError:
        raise ApiError(502, "Task service did not confirm your change. Refresh before retrying.") from None
    if task_id and result["id"] != task_id or owner and result.get("created_by") != owner:
        raise ApiError(502, "Task service did not confirm your change. Refresh before retrying.")
    return result


def dispatch(request, method):
    try:
        if method not in {"GET", "POST", "PATCH", "DELETE"}:
            raise ApiError(405, "Use GET, POST, PATCH, or DELETE for tasks.")
        user = authenticate(request.headers)
        raw_query = parse_qs(urlsplit(request.path).query, keep_blank_values=True)
        if any(len(values) != 1 for values in raw_query.values()):
            raise ApiError(400, "Send each task query parameter once.")
        query = {key: values[0] for key, values in raw_query.items()}
        allowed = {"action", "id"} if method in {"PATCH", "DELETE"} else {"action"}
        if set(query) - allowed:
            raise ApiError(400, "Unsupported task query parameter.")
        action = query.get("action", {"GET": "list", "POST": "create", "PATCH": "edit", "DELETE": "delete"}[method])
        if method == "GET":
            if action == "context":
                send_json(request, 200, context(user))
                return
            if action == "notifications":
                result = rpc(user, "notifications")
                if (not isinstance(result, dict) or not isinstance(result.get("notifications"), list)
                        or type(result.get("unread_count")) is not int or result["unread_count"] < 0):
                    raise ApiError(502, "Notifications could not be loaded. Please retry.")
                send_json(request, 200, result)
                return
            if action != "list":
                raise ApiError(400, "Choose a valid task action.")
            account = context(user)
            tasks = []
            for offset in range(0, 10001, 500):
                page = rpc(user, "list", {"p_offset": offset, "p_limit": 500})
                if not isinstance(page, list) or any(not isinstance(task, dict) for task in page):
                    raise ApiError(502, "Tasks could not be loaded. Please retry.")
                tasks.extend(page)
                if len(tasks) > 10000:
                    raise ApiError(400, "Too many tasks to load. Please contact your college administrator.")
                if len(page) < 500:
                    send_json(request, 200, {"tasks": tasks, "role": account["role"]})
                    return
            raise ApiError(400, "Too many tasks to load. Please contact your college administrator.")
        if method == "POST":
            if action != "create":
                raise ApiError(400, "Choose a valid task action.")
            request_id, payload = create_payload(body_json(request))
            if payload["audience"] != "personal":
                account = context(user)
                batch = payload["batch_id"]
                if (account["role"] != "teacher" or not any(item.get("id") == batch for item in account["batches"])
                        or payload["audience"] == "student" and not any(
                            item.get("id") == payload["assigned_to"] and item.get("batch_id") == batch
                            for item in account["students"])):
                    raise ApiError(403, "You can assign work only to approved students in your classes.")
            result = checked_task(rpc(user, "create", {"p_request_id": request_id, "p_data": payload}), owner=user.user_id)
            send_json(request, 201, {"task": result})
            return
        task_id = identifier(query.get("id"))
        if method == "DELETE":
            if action != "delete":
                raise ApiError(400, "Choose a valid task action.")
            result = rpc(user, "delete", {"p_id": task_id})
            if not isinstance(result, dict) or result.get("deleted") is not True:
                raise ApiError(502, "Task deletion could not be confirmed. Refresh before retrying.")
            send_json(request, 200, result)
            return
        if action == "edit":
            result = checked_task(rpc(user, "edit", {"p_id": task_id, "p_data": fields(body_json(request))}), task_id, user.user_id)
            send_json(request, 200, {"task": result})
        elif action == "status":
            result = checked_task(rpc(user, "status", {"p_id": task_id, "p_status": status_payload(body_json(request))}), task_id)
            send_json(request, 200, {"task": result})
        elif action == "read":
            if body_json(request):
                raise ApiError(400, "Notification read requests cannot change other fields.")
            result = rpc(user, "read_notification", {"p_id": task_id})
            if not isinstance(result, dict) or result.get("read") is not True:
                raise ApiError(502, "Notification read status could not be confirmed.")
            send_json(request, 200, result)
        else:
            raise ApiError(400, "Choose a valid task action.")
    except ApiError as exc:
        send_json(request, exc.status, {"error": exc.message.replace("calendar", "tasks")})
    except (BrokenPipeError, ConnectionResetError):
        return
    except Exception:
        send_json(request, 500, {"error": "Could not process your task request. Please retry."})


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
