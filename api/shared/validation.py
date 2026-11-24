"""Calendar validation independent of AI and browser-supplied identity."""
import re
from datetime import date, datetime, time, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from api.shared.supabase import ApiError

CATEGORIES = {"lecture", "assignment", "examination", "practical", "personal",
              "study_session", "college_event", "other"}
REMINDERS = {0, 5, 10, 15, 30, 60, 1440}
EVENT_FIELDS = {"title", "description", "category", "location", "all_day", "starts_at",
                "ends_at", "start_date", "end_date", "time_zone", "reminder_minutes"}


def bad(message):
    raise ApiError(400, message)


def identifier(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        bad("Choose a valid calendar event.")


def local_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        bad("Use a valid date in YYYY-MM-DD format.")
    try:
        result = date.fromisoformat(value)
        if result.year < 1000:
            bad("Use a date between years 1000 and 9999.")
        return result
    except ValueError:
        bad("Use a valid calendar date.")


def time_zone(value):
    if not isinstance(value, str) or not value or len(value) > 100:
        bad("Use a valid local timezone.")
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        bad("Use a valid IANA timezone.")


def instant(value):
    if (not isinstance(value, str) or len(value) > 40
            or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})", value)):
        bad("Use a valid date and time with a timezone offset.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        if result.year < 1000:
            bad("Use a date between years 1000 and 9999.")
        return result
    except (ValueError, OverflowError):
        bad("Use a valid event date and time.")


def text_field(body, key, maximum, required=False):
    value = body.get(key, "")
    if not isinstance(value, str) or len(value) > maximum:
        bad(f"{key.replace('_', ' ').capitalize()} must be text of at most {maximum} characters.")
    value = value.strip()
    if required and not value:
        bad("An event title is required.")
    return value


def event_payload(body):
    if not isinstance(body, dict) or set(body) - EVENT_FIELDS:
        bad("Send only supported calendar event fields.")
    if type(body.get("all_day")) is not bool:
        bad("Choose whether this is an all-day event.")
    zone = body.get("time_zone")
    time_zone(zone)
    category = body.get("category")
    if not isinstance(category, str) or category not in CATEGORIES:
        bad("Choose a valid event category.")
    reminder = body.get("reminder_minutes")
    if reminder is not None and (type(reminder) is not int or reminder not in REMINDERS):
        bad("Choose a valid reminder time.")
    result = {"title": text_field(body, "title", 200, True),
              "description": text_field(body, "description", 5000),
              "location": text_field(body, "location", 300),
              "category": category, "time_zone": zone,
              "reminder_minutes": reminder, "all_day": body["all_day"],
              "starts_at": None, "ends_at": None, "start_date": None, "end_date": None}
    if body["all_day"]:
        if body.get("starts_at") is not None or body.get("ends_at") is not None:
            bad("All-day events use dates, not timed boundaries.")
        start, end = local_date(body.get("start_date")), local_date(body.get("end_date"))
        if end <= start:
            bad("The all-day end boundary must be after its start date.")
        result.update(start_date=start.isoformat(), end_date=end.isoformat())
    else:
        if body.get("start_date") is not None or body.get("end_date") is not None:
            bad("Timed events use date and time boundaries.")
        start, end = instant(body.get("starts_at")), instant(body.get("ends_at"))
        if end <= start:
            bad("The event end must be after its start.")
        result.update(starts_at=start.isoformat(), ends_at=end.isoformat())
    return result


def date_range(query):
    start, end = local_date(query.get("start")), local_date(query.get("end"))
    zone = time_zone(query.get("time_zone"))
    if not 0 < (end - start).days <= 62:
        bad("Choose a date range of 1 to 62 days.")
    lower = datetime.combine(start, time.min, zone).astimezone(timezone.utc).isoformat()
    upper = datetime.combine(end, time.min, zone).astimezone(timezone.utc).isoformat()
    return {"or": f"(and(all_day.eq.false,starts_at.lt.{upper},ends_at.gt.{lower}),"
                  f"and(all_day.eq.true,start_date.lt.{end.isoformat()},end_date.gt.{start.isoformat()}))"}
