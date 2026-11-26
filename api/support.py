"""Private support intake. The public endpoint accepts submissions only."""
import hashlib
import hmac
import ipaddress
import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from uuid import UUID

from api.shared.ai_rpc import _service_headers
from api.shared.ai_service import NoRedirect
from api.shared.supabase import ApiError, configuration

_transport = build_opener(NoRedirect())
CONTACT = "mannsathi.official@gmail.com"


def fields(data):
    if not isinstance(data, dict) or set(data) != {"request_id", "kind", "detail", "email"}:
        raise ApiError(400, "Check the fields and send again.")
    try:
        request_id = UUID(str(data["request_id"]))
    except ValueError:
        raise ApiError(400, "Refresh the page and try again.") from None
    detail, email, kind = data["detail"], data["email"], data["kind"]
    if kind not in ("bug", "privacy") or not isinstance(detail, str) or not 10 <= len(detail.strip()) <= 2000 or "\x00" in detail:
        raise ApiError(400, "Enter a description between 10 and 2,000 characters.")
    if not isinstance(email, str) or len(email) > 254 or (email and not re.fullmatch(r"[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+", email)) or (kind == "privacy" and not email):
        raise ApiError(400, "Enter a valid reply email.")
    return {"p_id": str(request_id), "p_kind": kind, "p_detail": detail.strip(), "p_email": email or None}


def submit(data, address):
    params = fields(data)
    url, _ = configuration()
    headers = _service_headers()
    day = datetime.now(timezone.utc).date().isoformat()
    try:
        address = ipaddress.ip_address(address).compressed
    except ValueError:
        address = "unknown"
    params["p_source"] = hmac.new(headers["apikey"].encode(), f"support/{day}/{address}".encode(), hashlib.sha256).hexdigest()
    req = Request(url + "/rest/v1/rpc/mannsathi_submit_support", json.dumps(params).encode(), headers, method="POST")
    try:
        with _transport.open(req, timeout=8) as result:
            if json.loads(result.read(256)) != params["p_id"]:
                raise ValueError("Unconfirmed reference")
    except HTTPError as error:
        if error.code == 429:
            raise ApiError(429, "Too many requests. Try later or use the support email.") from None
        if error.code == 409:
            raise ApiError(409, "Refresh the form and send a new request.") from None
        raise ApiError(503, "The support inbox is temporarily unavailable.") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise ApiError(503, "The support inbox could not confirm delivery.") from None
    return {"reference": params["p_id"]}


def dispatch(request):
    try:
        if request.headers.get_content_type() != "application/json":
            raise ApiError(415, "Use the support form to submit a request.")
        length = int(request.headers.get("Content-Length", "0"))
        if not 0 < length <= 16000:
            raise ApiError(400, "Check the request length.")
        address = request.client_address[0]
        if os.environ.get("VERCEL") == "1":
            address = request.headers.get("x-vercel-forwarded-for", address).split(",")[0].strip()
        body = submit(json.loads(request.rfile.read(length)), address)
        status = 201
    except (UnicodeError, ValueError, RecursionError):
        status, body = 400, {"error": "Invalid request."}
    except ApiError as error:
        status = error.status
        body = {"error": error.message if status < 500 else "The support inbox is unavailable. Contact " + CONTACT + "."}
    data = json.dumps(body).encode()
    request.send_response(status)
    request.send_header("Content-Type", "application/json; charset=utf-8")
    request.send_header("Cache-Control", "no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    request.send_header("Content-Length", str(len(data)))
    request.end_headers()
    request.wfile.write(data)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        dispatch(self)

    def log_message(self, *args):
        pass
