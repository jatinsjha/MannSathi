"""Strict focus input validation. Study duration is measured by SQL timestamps."""
import re
from datetime import date
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from api.shared.supabase import ApiError

PREF_RANGES = {"focus_minutes": (1, 180), "short_break_minutes": (1, 60),
               "long_break_minutes": (1, 120), "sessions_before_long": (1, 12)}


def invalid(message):
    raise ApiError(400, message)


def identifier(value):
    try:
        return str(UUID(value))
    except (TypeError, ValueError, AttributeError):
        invalid("Choose a valid subject, task, or focus session.")


def timezone(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 100 or "\x00" in value:
        invalid("Choose a valid IANA timezone.")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        invalid("Choose a valid IANA timezone.")
    return value


def subject_payload(body, edit=False):
    keys = {"name", "color", "weekly_goal_minutes"} | ({"archived"} if edit else set())
    if not isinstance(body, dict) or set(body) != keys:
        invalid("Send only the subject name, color, weekly goal, and archive setting when editing.")
    name = body["name"]
    if not isinstance(name, str) or "\x00" in name or not 1 <= len(name.strip()) <= 100:
        invalid("A subject name of 1 to 100 characters is required.")
    color = body["color"]
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        invalid("Choose a valid subject color.")
    goal = body["weekly_goal_minutes"]
    if type(goal) is not int or not 0 <= goal <= 10080:
        invalid("A weekly goal must be 0 to 10080 whole minutes.")
    result = {"name": name.strip(), "color": color.lower(), "weekly_goal_minutes": goal}
    if edit:
        if type(body["archived"]) is not bool:
            invalid("Choose whether to archive the subject.")
        result["archived"] = body["archived"]
    return result


def prefs_payload(body):
    if not isinstance(body, dict) or set(body) != set(PREF_RANGES) | {"auto_start", "sound"}:
        invalid("Send only the six timer preference settings.")
    for key, (minimum, maximum) in PREF_RANGES.items():
        if type(body[key]) is not int or not minimum <= body[key] <= maximum:
            invalid(key.replace("_", " ").capitalize() + f" must be {minimum} to {maximum} whole minutes or sessions.")
    if type(body["auto_start"]) is not bool or type(body["sound"]) is not bool:
        invalid("Auto start and sound settings must be true or false.")
    return dict(body)


def start_payload(body):
    if not isinstance(body, dict) or set(body) != {"session_id", "subject_id", "task_id", "planned_minutes", "time_zone"}:
        invalid("Send only a session ID, subject, optional task, planned minutes, and timezone.")
    minutes = body["planned_minutes"]
    if type(minutes) is not int or not 1 <= minutes <= 180:
        invalid("A focus interval must be 1 to 180 whole minutes.")
    return {"p_session_id": identifier(body["session_id"]), "p_subject_id": identifier(body["subject_id"]),
            "p_task_id": identifier(body["task_id"]) if body["task_id"] is not None else None,
            "p_planned_minutes": minutes, "p_time_zone": timezone(body["time_zone"])}


def history_range(query):
    try:
        if not all(isinstance(query.get(key), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", query[key]) for key in ("start", "end")):
            raise ValueError()
        start, end = date.fromisoformat(query["start"]), date.fromisoformat(query["end"])
        if not 0 <= (end - start).days <= 365:
            raise ValueError()
    except ValueError:
        invalid("Choose a history range of at most 366 days, with dates in YYYY-MM-DD format.")
    return {"p_start": start.isoformat(), "p_end": end.isoformat(), "p_time_zone": timezone(query.get("time_zone"))}
