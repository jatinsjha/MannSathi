"""Teacher exam input: identity and permissions are supplied by the server."""
from api.shared.supabase import ApiError
from api.shared.validation import EVENT_FIELDS, event_payload, identifier

AUDIENCE_FIELDS = {"audience", "batch_id", "target_division", "assigned_to"}


def exam_payload(body):
    if not isinstance(body, dict) or set(body) - EVENT_FIELDS - AUDIENCE_FIELDS:
        raise ApiError(400, "Send only supported exam fields.")
    result = event_payload({key: value for key, value in body.items() if key in EVENT_FIELDS})
    if result["category"] != "examination":
        raise ApiError(400, "Assigned exams must use the Examination category.")
    audience, batch = body.get("audience"), body.get("batch_id")
    if not isinstance(audience, str) or audience not in {"class", "division", "student"}:
        raise ApiError(400, "Choose a class, division, or student for this exam.")
    if not isinstance(batch, str) or not 1 <= len(batch.strip()) <= 80:
        raise ApiError(400, "Choose a valid class for this exam.")
    division, student = body.get("target_division"), body.get("assigned_to")
    if audience == "division":
        if not isinstance(division, str) or division not in {"A", "B", "C"} or student is not None:
            raise ApiError(400, "Choose a valid division for this exam.")
    elif division is not None:
        raise ApiError(400, "Only division exams may target a division.")
    if audience == "student":
        student = identifier(student)
    elif student is not None:
        raise ApiError(400, "Only individual exams may target a student.")
    return {**result, "audience": audience, "batch_id": batch.strip(),
            "target_division": division, "assigned_to": student}
