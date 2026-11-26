"""Server-side administration of AI usage. Browser credentials never access the ledger."""
import csv
import io
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from api.shared.ai_service import configured_model, rpc, verified_user_id
from api.shared.supabase import ApiError
from api.shared.validation import instant, local_date


DATE = {"start", "end", "period"}
PAGE = {"page", "page_size"}
LOG_FILTERS = {"user_id", "status", "model", "feature"}
REPORTS = {
    "access": set(), "overview": DATE, "billing": set(), "provider": set(), "settings": set(),
    "students": DATE | PAGE | {"q", "status", "sort", "class_code", "division"},
    "student": DATE | PAGE | {"user_id"}, "audit": DATE | PAGE,
    "logs": DATE | PAGE | LOG_FILTERS, "export": DATE | LOG_FILTERS,
}
CHANGES = {
    "global": {"enabled", "requests_per_minute", "daily_token_limit", "monthly_token_limit",
               "guest_request_limit", "guest_token_limit", "warning_thresholds", "monthly_budget"},
    "student_policy": {"enabled", "daily_token_limit", "monthly_token_limit", "request_limit", "restricted",
                       "restriction_reason", "restricted_until"},
    "pricing": {"model", "input_per_million", "output_per_million"},
}
LOG_COLUMNS = ("request_id", "user_id", "retry_of", "created_at", "model", "reported_model", "feature",
               "input_tokens", "output_tokens", "thought_tokens", "total_tokens", "duration_ms", "status",
               "generation_attempted", "error_category")
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,149}")


def bad(message):
    raise ApiError(400, message)


def uuid_value(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        bad("Choose a valid student ID.")


def number(value, ceiling):
    return type(value) in (int, float) and 0 <= value <= ceiling and math.isfinite(value)


def short_text(value, maximum):
    return isinstance(value, str) and len(value) <= maximum and not any(ord(c) < 32 for c in value)


def report_dates(fields, today):
    if "period" in fields and ("start" in fields or "end" in fields):
        bad("Choose a preset or a pair of dates.")
    if "start" in fields or "end" in fields:
        if not {"start", "end"} <= fields.keys():
            bad("Choose both a start and an end date.")
        start, end = local_date(fields["start"]), local_date(fields["end"])
    else:
        period = fields.pop("period", "7")
        end = today
        if period in {"today", "7", "30"}:
            days = 1 if period == "today" else int(period)
            start = end - timedelta(days=days-1)
        elif period == "month":
            start = end.replace(day=1)
        elif period == "previous":
            end = today.replace(day=1) - timedelta(days=1)
            start = end.replace(day=1)
        else:
            bad("Choose a supported reporting period.")
    if not 0 <= (end-start).days < 366:
        bad("Choose a date range of up to 366 days.")
    fields.update(start=start.isoformat(), end=end.isoformat())


def query_filters(path, method):
    if len(path) > 4096:
        bad("Report filters are too long.")
    try:
        args = parse_qs(urlsplit(path).query, keep_blank_values=True, max_num_fields=16)
    except ValueError:
        bad("Invalid report filters.")
    if any(len(items) != 1 for items in args.values()):
        bad("Send each parameter once.")
    fields = {k: v[0] for k, v in args.items()}
    action = fields.pop("action", "access" if method == "GET" else "")
    if method == "POST":
        if fields or action not in CHANGES:
            bad("Choose a supported administration change.")
        return action, {}
    if action not in REPORTS or set(fields) - REPORTS[action]:
        bad("Unsupported report or filter.")
    if DATE <= REPORTS[action]:
        report_dates(fields, datetime.now(timezone.utc).date())
    for key, limit, default in (("page", 100000, 1), ("page_size", 100, 25)):
        if key in REPORTS[action]:
            value = fields.get(key, str(default))
            if not re.fullmatch(r"[0-9]{1,6}", value) or not 1 <= int(value) <= limit:
                bad(f"Choose a {key.replace('_', ' ')} between 1 and {limit}.")
            fields[key] = int(value)
    if action == "student" or "user_id" in fields:
        fields["user_id"] = uuid_value(fields.get("user_id"))
    statuses = {"active", "idle", "restricted", "warning"} if action == "students" else {"success", "failed", "blocked", "pending"}
    if "status" in fields and fields["status"] not in statuses:
        bad("Choose a supported status.")
    if "sort" in fields and fields["sort"] not in {"tokens", "requests", "cost", "recent"}:
        bad("Choose a supported sort order.")
    for key, length in (("q", 160), ("class_code", 80), ("division", 40), ("feature", 64), ("model", 150)):
        if key in fields and (not short_text(fields[key], length) or not fields[key].strip()):
            bad(f"Invalid {key} filter.")
    return action, fields


def read_change(request, action):
    if request.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "Send administration changes as JSON.")
    try:
        size = int(request.headers.get("Content-Length", "0"))
    except ValueError:
        bad("Invalid change size.")
    if not 0 < size <= 8192:
        bad("Invalid change size.")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError("Nonfinite number")

    try:
        body = json.loads(request.rfile.read(size), object_pairs_hook=unique, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        bad("Send a valid JSON object.")
    allowed = {"values", "reason", "user_id"} if action == "student_policy" else {"values", "reason"}
    if not isinstance(body, dict) or set(body) - allowed:
        bad("Unsupported administration fields.")
    values, reason = body.get("values"), body.get("reason")
    if not isinstance(values, dict) or not values or set(values)-CHANGES[action]:
        bad("Choose supported policy or pricing fields.")
    if reason is not None and not short_text(reason, 500):
        bad("Use a reason of up to 500 characters.")
    for key, value in values.items():
        if key in {"enabled", "restricted"}:
            if type(value) is not bool:
                bad("Use true or false for AI access settings.")
        elif key == "model":
            if not isinstance(value, str) or not MODEL.fullmatch(value):
                bad("Use a valid Gemini model name.")
        elif key in {"input_per_million", "output_per_million"}:
            if not number(value, 1_000_000):
                bad("Enter a nonnegative USD price up to 1,000,000 per million tokens.")
        elif key == "monthly_budget":
            if value is not None and not number(value, 1_000_000_000):
                bad("Enter a nonnegative USD budget up to 1,000,000,000.")
        elif key == "warning_thresholds":
            if (not isinstance(value, list) or not 1 <= len(value) <= 100 or
                    any(type(v) is not int or not 1 <= v <= 100 for v in value) or len(set(value)) != len(value)):
                bad("Use unique whole warning percentages from 1 to 100.")
        elif key == "restriction_reason":
            if value is not None and not short_text(value, 500):
                bad("Use a restriction reason of up to 500 characters.")
        elif key == "restricted_until":
            if value is not None:
                instant(value)
        elif value is not None and (type(value) is not int or not 0 <= value <= 1_000_000_000_000):
            bad("Limits must be whole numbers from 0 to 1,000,000,000,000 or null.")
    if action == "pricing" and "model" not in values:
        bad("Choose a model for this price.")
    return {"p_scope": "student" if action == "student_policy" else action,
            "p_target": uuid_value(body.get("user_id")) if action == "student_policy" else None,
            "p_values": values, "p_reason": reason}


def csv_report(data):
    if not isinstance(data.get("rows"), list) or len(data["rows"]) != data.get("total") or len(data["rows"]) > 10000:
        raise ApiError(502, "The export was incomplete. Narrow your filters and retry.")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(LOG_COLUMNS)
    for row in data["rows"]:
        cells = []
        for field in LOG_COLUMNS:
            cell = row.get(field)
            if isinstance(cell, str) and cell.lstrip().startswith(("=", "+", "-", "@")):
                cell = "'" + cell
            cells.append(cell)
        writer.writerow(cells)
    return stream.getvalue().encode("utf-8-sig")


def enrich_report(action, actor, result, model):
    if action in {"settings", "provider"}:
        result.update(configured_model=model, key_configured=bool(os.environ.get("GEMINI_API_KEY", "").strip()))
    defaults = {"provider": {"metrics": [], "last_sync": None, "project": None},
                "billing": {"actual_spend": None, "last_billing_update": None, "billing_through": None, "project": None},
                "settings": {"provider_monitoring": "unavailable"}}
    if action not in defaults:
        return
    project = os.environ.get("GEMINI_CLOUD_PROJECT") or None
    try:
        values = rpc("mannsathi_ai_provider_snapshot", {"p_admin_id": actor, "p_action": action,
                     "p_project": project})
        if not isinstance(values, dict):
            raise ApiError(502, "Invalid monitoring snapshot.")
        if action in {"billing", "provider"} and (not project or values.get("project") != project):
            values = {}
        if action == "provider" and values:
            rows = values.get("metrics")
            if (not isinstance(rows, list) or any(
                    not isinstance(row, dict) or row.get("project") != project or row.get("metric") not in {"RPM", "TPM", "RPD"}
                    or not row.get("model") or not row.get("metric_id") or not row.get("window_start") or not row.get("window_end")
                    or not number(row.get("reported_limit"), float("inf"))
                    or (row.get("consumption") is not None and not number(row["consumption"], float("inf"))) for row in rows)):
                raise ApiError(502, "Invalid quota snapshot.")
    except ApiError as exc:
        if exc.status not in (502, 503):
            raise
        values = {}
        result["monitoring_error"] = "Provider snapshot storage is unavailable."
    # A snapshot can supply only the expected provider fields. The database
    # validates metric dimensions, timestamps, cost scope and matching periods.
    result.update({k: values.get(k, default) for k, default in defaults[action].items()})
    if action == "billing" and result["actual_spend"] is not None:
        spend, budget = result["actual_spend"], result.get("budget")
        if not number(spend, float("inf")) or not result["last_billing_update"]:
            result.update(actual_spend=None, last_billing_update=None, billing_through=None)
            return
        result.update(budget_basis="actual_provider_spend",
                      remaining_budget=budget-spend if budget is not None else None,
                      budget_pct=round(100*spend/budget, 2) if budget else None)


def send_response(request, status, data, download=False):
    raw = data if download else json.dumps(data, allow_nan=False).encode("utf-8")
    request.send_response(status)
    request.send_header("Content-Type", "text/csv; charset=utf-8" if download else "application/json; charset=utf-8")
    request.send_header("Content-Length", str(len(raw)))
    request.send_header("Cache-Control", "private, no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    if download:
        request.send_header("Content-Disposition", 'attachment; filename="mannsathi-ai-requests.csv"')
    if status == 405:
        request.send_header("Allow", "GET, POST")
    request.end_headers()
    request.wfile.write(raw)


def dispatch(request, method):
    try:
        if method not in {"GET", "POST"}:
            raise ApiError(405, "Use GET or POST for AI administration.")
        actor = verified_user_id(request.headers)
        if rpc("mannsathi_ai_admin_gate", {"p_admin_id": actor}) is not True:
            raise ApiError(403, "Administrator access is required.")
        action, filters = query_filters(request.path, method)
        if action == "access":
            return send_response(request, 200, {"admin": True})
        if method == "POST":
            payload = read_change(request, action)
            result = rpc("mannsathi_ai_admin_change", {"p_admin_id": actor, **payload})
            if not isinstance(result, dict):
                raise ApiError(502, "The policy change could not be confirmed.")
            return send_response(request, 200, {"saved": result})
        model = configured_model() if action in {"provider", "settings"} else None
        if action == "provider":
            filters["model"] = model
        result = rpc("mannsathi_ai_report", {"p_admin_id": actor, "p_action": action, "p_filters": filters})
        if not isinstance(result, dict):
            raise ApiError(502, "The report could not be confirmed.")
        if action == "export":
            return send_response(request, 200, csv_report(result), download=True)
        if "start" in filters:
            result.update(start=filters["start"], end=filters["end"])
        enrich_report(action, actor, result, model)
        send_response(request, 200, result)
    except ApiError as exc:
        send_response(request, exc.status, {"error": exc.message})
    except (ConnectionResetError, BrokenPipeError):
        return
    except Exception:
        send_response(request, 500, {"error": "Could not process the administration request."})


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        dispatch(self, "GET")

    def do_POST(self):
        dispatch(self, "POST")

    def do_PATCH(self):
        dispatch(self, "PATCH")

    do_DELETE = do_PATCH
    do_PUT = do_PATCH

    def log_message(self, format, *args):
        return
