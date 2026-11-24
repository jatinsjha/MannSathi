"""Deterministic task validation; role and assignment authorization stay on the server."""
import re
from uuid import UUID

from api.shared.supabase import ApiError
from api.shared.validation import instant

STATUSES = {"pending", "in_progress", "completed"}
PRIORITIES = {"low", "medium", "high", "urgent"}
DIVISIONS = {"A", "B", "C"}
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
        invalid("A task title is required." if key == "title" else key.replace("_", " ").capitalize() + " is required.")
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
    allowed = FIELDS | {"request_id", "audience", "assigned_to", "batch_id", "status", "target_division"}
    if not isinstance(body, dict) or set(body) - allowed:
        invalid("Send only supported task fields.")
    request_id = identifier(body.get("request_id"))
    result = fields({key: value for key, value in body.items() if key in FIELDS})
    audience, status = body.get("audience", "personal"), body.get("status", "pending")
    if not isinstance(audience, str) or audience not in {"personal", "student", "class", "division"}:
        invalid("Choose a valid task audience.")
    if not isinstance(status, str) or status not in STATUSES:
        invalid("Choose a valid task status.")
    batch, target = body.get("batch_id"), body.get("assigned_to")
    division = body.get("target_division")
    if audience == "division":
        division = division_code(division)
    elif division is not None:
        invalid("Choose a division only for a division assignment.")
    if audience == "personal":
        if batch is not None or target is not None:
            invalid("The server sets personal task ownership.")
    else:
        batch = class_code(batch)
        if status != "pending":
            invalid("New teacher assignments start as pending.")
        if audience == "student":
            target = identifier(target)
        elif target is not None:
            invalid("Class assignments cannot also target one student.")
    result.update(audience=audience, status=status, batch_id=batch, assigned_to=target)
    if division is not None:
        result["target_division"] = division
    return request_id, result


def class_code(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80 or "\x00" in value:
        invalid("Choose a valid class.")
    return value.strip().lower()


def division_code(value):
    if not isinstance(value, str) or value.strip().upper() not in DIVISIONS:
        invalid("Choose division A, B, or C.")
    return value.strip().upper()


def settings_payload(body):
    if not isinstance(body, dict) or set(body) != {"full_name", "roll_number", "class_code", "division"}:
        invalid("Send only name, roll number, class, and division settings.")
    name = text_field(body, "full_name", 100, True)
    if len(name) < 2:
        invalid("Your name must have at least 2 characters.")
    roll = text_field(body, "roll_number", 30, True)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 /_-]{0,29}", roll):
        invalid("Roll number must start with a letter or number and use only letters, numbers, spaces, /, _, or -.")
    batch = class_code(body["class_code"])
    if batch != "25cs":
        invalid("Choose an available class. Student enrollment currently supports 25CS.")
    return {"full_name": name, "roll_number": roll, "class_code": batch, "division": division_code(body["division"])}


def enrollment_payload(body):
    if not isinstance(body, dict) or set(body) != {"student_id", "batch_id", "approve", "expected_division"}:
        invalid("Send the student, class, reviewed division, and approval decision only.")
    if type(body["approve"]) is not bool:
        invalid("Choose whether to approve or reject this enrollment.")
    expected = body["expected_division"]
    return {"p_user": identifier(body["student_id"]), "p_batch": class_code(body["batch_id"]),
            "p_approve": body["approve"], "p_expected_division": division_code(expected) if expected is not None else None}


def status_payload(body):
    if not isinstance(body, dict) or set(body) != {"status"} or not isinstance(body["status"], str) or body["status"] not in STATUSES:
        invalid("Send a valid task status only.")
    return body["status"]
