"""Deterministic task validation; role and assignment authorization stay on the server."""
from uuid import UUID

from api.shared.supabase import ApiError
from api.shared.validation import instant

STATUSES = {"pending", "in_progress", "completed"}
PRIORITIES = {"low", "medium", "high", "urgent"}
TASK_TYPES = {"personal_task", "homework", "assignment", "practical", "examination_preparation", "project", "other"}
FIELDS = {"title", "description", "subject", "task_type", "due_at", "estimated_minutes", "priority"}


def invalid(message):
    raise ApiError(400, message)


def identifier(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        invalid("Choose a valid task or notification.")


def text_field(body, key, maximum, required=False):
    value = body.get(key, "")
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        invalid(f"{key.replace('_', ' ').capitalize()} must be text of at most {maximum} characters.")
    value = value.strip()
    if required and not value:
        invalid("A task title is required.")
    return value


def fields(body):
    if not isinstance(body, dict) or set(body) - FIELDS:
        invalid("Send only editable task fields.")
    task_type, priority = body.get("task_type", "personal_task"), body.get("priority", "medium")
    if not isinstance(task_type, str) or task_type not in TASK_TYPES:
        invalid("Choose a valid task type.")
    if not isinstance(priority, str) or priority not in PRIORITIES:
        invalid("Choose a valid task priority.")
    minutes = body.get("estimated_minutes")
    if minutes is not None and (type(minutes) is not int or not 1 <= minutes <= 10080):
        invalid("Estimated completion time must be 1 to 10080 whole minutes.")
    due = body.get("due_at")
    return {"title": text_field(body, "title", 200, True),
            "description": text_field(body, "description", 5000),
            "subject": text_field(body, "subject", 120),
            "task_type": task_type, "priority": priority,
            "estimated_minutes": minutes,
            "due_at": instant(due).isoformat() if due is not None else None}


def create_payload(body):
    allowed = FIELDS | {"request_id", "audience", "assigned_to", "batch_id", "status"}
    if not isinstance(body, dict) or set(body) - allowed:
        invalid("Send only supported task fields.")
    request_id = identifier(body.get("request_id"))
    result = fields({key: value for key, value in body.items() if key in FIELDS})
    audience, status = body.get("audience", "personal"), body.get("status", "pending")
    if not isinstance(audience, str) or audience not in {"personal", "student", "class"}:
        invalid("Choose a valid task audience.")
    if not isinstance(status, str) or status not in STATUSES:
        invalid("Choose a valid task status.")
    batch, target = body.get("batch_id"), body.get("assigned_to")
    if audience == "personal":
        if batch is not None or target is not None:
            invalid("The server sets personal task ownership.")
    else:
        if not isinstance(batch, str) or not 1 <= len(batch) <= 80 or batch != batch.strip() or "\x00" in batch:
            invalid("Choose a valid class.")
        if status != "pending":
            invalid("New teacher assignments start as pending.")
        if audience == "student":
            target = identifier(target)
        elif target is not None:
            invalid("Class assignments cannot also target one student.")
    result.update(audience=audience, status=status, batch_id=batch, assigned_to=target)
    return request_id, result


def status_payload(body):
    if not isinstance(body, dict) or set(body) != {"status"} or not isinstance(body["status"], str) or body["status"] not in STATUSES:
        invalid("Send a valid task status only.")
    return body["status"]
