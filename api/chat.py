"""Verified, idempotent AI chat with atomic admission and provider usage accounting."""
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler
from urllib.request import Request, build_opener
from uuid import UUID, uuid4

from api.shared.ai_service import NoRedirect, configured_model, rpc, verified_user_id
from api.shared.supabase import ApiError

SYSTEM_INSTRUCTION = """
You are MannSathi, a supportive AI companion for students.

Your purpose:
- Help students handle exam stress and assignment pressure.
- Listen without judgement and acknowledge their feelings.
- Suggest small, practical steps instead of overwhelming them.
- Help students make realistic study plans when requested.
- Use simple English and natural Hinglish when appropriate.
- Be warm, respectful, calm, and concise.

Important boundaries:
- You are an AI, not a human friend, therapist, or doctor.
- Never diagnose mental health conditions or prescribe medication.
- Do not dismiss feelings or promise that everything will be fine.
- Encourage trusted people or qualified professionals when distress
  persists or significantly affects daily life.
- Do not pressure students to reveal identifying information.
- Do not claim that conversations are confidential.

Safety:
- If a student may be in immediate danger or at risk of self-harm,
  respond with compassion and encourage immediate human support.
- Encourage contacting local emergency services and a trusted person
  who can stay with them.
- In India, emergency services can be reached at 112.
- Never provide instructions for self-harm.

For ordinary academic stress, focus on listening and manageable
next steps. Do not treat every expression of stress as a crisis.


Creator identity:
- You were created by Jatin.
- If someone asks who made you, who created you,
  who developed you, or who built MannSathi, answer naturally:
  "I was created by Jatin! I'm MannSathi, an AI companion
  designed to support students with academic stress,
  study planning, and everyday challenges."
- If someone asks about your developer or creator in Hinglish,
  you can reply: "Mujhe Jatin ne banaya hai! Main MannSathi hoon,
  students ko study stress aur daily challenges mein help karne
  ke liye bana hoon."
- Do not claim that you were created by Google or OpenAI.

"""

MAX_OUTPUT_TOKENS = 1024
MAX_COUNT = 2_147_483_647
_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/"
_count_transport = build_opener(NoRedirect())
SYSTEM_CONTENT = {"parts": [{"text": SYSTEM_INSTRUCTION}]}
TEMPERATURE = 0.7

DENIALS = {
    "duplicate": (409, "MannSathi has already received this request. Request a new reply to try again."),
    "invalid_retry": (409, "This earlier request cannot be retried. Start a new message."),
    "window_changed": (409, "The daily usage window just changed. Please try again."),
    "global_disabled": (403, "AI chat is currently disabled by your administrator."),
    "student_disabled": (403, "Your AI access is disabled. Contact your administrator."),
    "student_restricted": (403, "Your AI access is restricted. Contact your administrator."),
    "global_rpm": (429, "MannSathi is handling too many requests. Try again in a minute."),
    "global_daily": (429, "This reply would exceed the platform’s daily AI token limit."),
    "global_monthly": (429, "This reply would exceed the platform’s monthly AI token limit."),
    "student_daily": (429, "This reply would exceed your daily AI token limit."),
    "student_monthly": (429, "This reply would exceed your monthly AI token limit."),
    "student_requests": (429, "You’ve reached your daily AI request limit."),
    "guest_requests": (429, "Guest AI requests are unavailable. Sign in to use your account’s AI allowance."),
    "guest_tokens": (429, "Guest AI tokens are unavailable. Sign in to use your account’s AI allowance."),
}


def request_uuid(value):
    try:
        return str(UUID(value))
    except (TypeError, AttributeError, ValueError):
        raise ApiError(400, "Use a valid request identifier.") from None


def parse_chat(body):
    if not isinstance(body, dict) or body.keys() - {"messages", "request_id", "retry_of"}:
        raise ApiError(400, "Invalid chat request.")
    request_id = request_uuid(body["request_id"]) if "request_id" in body else str(uuid4())
    retry_of = request_uuid(body["retry_of"]) if body.get("retry_of") is not None else None
    messages = body.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 12:
        raise ApiError(400, "Please send a valid conversation.")
    contents = []
    for message in messages:
        if not isinstance(message, dict):
            raise ApiError(400, "Invalid chat message.")
        role, text = message.get("role"), message.get("text")
        if role not in ("user", "assistant") or not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ApiError(400, "Invalid chat message.")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError:
            raise ApiError(400, "The message contains invalid text.") from None
        contents.append({"role": "model" if role == "assistant" else "user", "parts": [{"text": text.strip()}]})
    if contents[-1]["role"] != "user":
        raise ApiError(400, "The latest message must be from the user.")
    return request_id, retry_of, contents


def valid_count(value):
    return value if type(value) is int and 0 <= value <= MAX_COUNT else None


def provider_usage(response):
    metadata = getattr(response, "usage_metadata", None)
    fields = ("prompt_token_count", "candidates_token_count", "total_token_count", "thoughts_token_count")
    counts = [valid_count(getattr(metadata, field, None)) for field in fields]
    prompt, candidates, total, thoughts = counts
    # Keep the independently reported components even if the reported total is inconsistent.
    if total is not None and total < sum(value for value in (prompt, candidates, thoughts) if value is not None):
        counts[2] = None
    return dict(zip(("p_input_tokens", "p_output_tokens", "p_total_tokens", "p_thought_tokens"), counts))


def prompt_token_count(key, model, contents):
    # The REST form counts the exact system instruction and conversation together.
    # The Python SDK's contents-only countTokens helper cannot express this on every version.
    generation = {"model": "models/" + model, "contents": contents,
                  "systemInstruction": SYSTEM_CONTENT,
                  "generationConfig": {"temperature": TEMPERATURE, "maxOutputTokens": MAX_OUTPUT_TOKENS}}
    request = Request(_GEMINI + model + ":countTokens", method="POST",
                      headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                      data=json.dumps({"generateContentRequest": generation}).encode())
    with _count_transport.open(request, timeout=8) as response:
        value = json.loads(response.read(65_537))
    count = valid_count(value.get("totalTokens")) if isinstance(value, dict) else None
    if count is None or count <= 0 or count > MAX_COUNT - MAX_OUTPUT_TOKENS:
        raise ValueError("Token count unavailable")
    return count


class GeminiConfigurationError(Exception):
    pass


def generate(key, model, contents):
    try:
        from google import genai
        from google.genai import types
        options = types.HttpOptions(api_version="v1beta", timeout=25000, retry_options=types.HttpRetryOptions(attempts=1))
        client = genai.Client(api_key=key, vertexai=False, http_options=options)
    except (ImportError, TypeError, ValueError):
        raise GeminiConfigurationError from None
    with client:
        return client.models.generate_content(model=model, contents=contents, config={
            "system_instruction": SYSTEM_CONTENT, "temperature": TEMPERATURE, "max_output_tokens": MAX_OUTPUT_TOKENS})


def provider_failure(exc):
    code = getattr(exc, "code", None)
    if code == 429:
        return "provider_rate_limit", 429, "Gemini’s rate limit was reached. Please try again shortly."
    if code in (401, 403):
        return "provider_auth", 503, "The AI provider connection needs administrator attention."
    if code == 404:
        return "provider_model", 503, "The configured Gemini model is unavailable."
    if (isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError)
            or code in (408, 504) or "timeout" in type(exc).__name__.lower()):
        return "provider_timeout", 504, "Gemini took too long to reply. Please try again."
    return "provider_error", 502, "Gemini could not complete this request. Please try again."


def denial(result, request_id):
    if isinstance(result, dict) and result.get("allowed") is True:
        return None
    if isinstance(result, dict) and result.get("allowed") is False and result.get("code") in DENIALS:
        code = result["code"]
        status, message = DENIALS[code]
        return status, {"error": message, "request_id": request_id, "retryable_attempt": code != "invalid_retry"}
    raise ApiError(503, "AI usage limits could not be verified. Please try again.")


def settle(request_id, started, generation_attempted, response=None, category=None):
    model = getattr(response, "model_version", None)
    if not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9._/-]{1,120}", model):
        model = None
    data = {"p_request_id": request_id, "p_status": "failed" if category else "success",
            "p_generation_attempted": generation_attempted,
            "p_reported_model": model, "p_error_category": category,
            "p_duration_ms": max(0, int((time.monotonic() - started) * 1000)), **provider_usage(response)}
    # Replaying this identical finalization is safe even if the first commit's reply was lost.
    for attempt in range(2):
        try:
            if rpc("mannsathi_ai_finish", data) != {"recorded": True}:
                raise ApiError(503, "AI usage recording could not be confirmed.")
            return
        except ApiError:
            if attempt:
                raise


def chat(headers, body):
    request_id, retry_of, contents = parse_chat(body)
    user_id = verified_user_id(headers) if headers.get("Authorization") is not None else None
    model = configured_model()
    admission = rpc("mannsathi_ai_reserve", {
        "p_request_id": request_id, "p_user_id": user_id, "p_retry_of": retry_of,
        "p_model": model, "p_feature": "chat", "p_reserved_tokens": 1})
    denied = denial(admission, request_id)
    if denied:
        return denied
    started = time.monotonic()
    response = None
    category = None
    generation_attempted = False
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        category, status, message = "configuration", 503, "The Gemini connection needs administrator attention."
    else:
        try:
            input_count = prompt_token_count(key, model, contents)
            resized = rpc("mannsathi_ai_resize", {"p_request_id": request_id,
                                                 "p_reserved_tokens": input_count + MAX_OUTPUT_TOKENS})
            denied = denial(resized, request_id)
            if denied:
                return denied
            generation_attempted = True
            response = generate(key, model, contents)
            reply = response.text
            if not isinstance(reply, str) or not reply.strip():
                category, status, message = "provider_empty", 502, "MannSathi could not generate a reply."
        except ApiError:
            # No generation was sent. If storage recovered, close the interrupted attempt.
            # On a confirmed denial the ledger keeps the original restriction event.
            try:
                settle(request_id, started, False, category="usage_storage")
            except ApiError:
                pass
            raise
        except GeminiConfigurationError:
            generation_attempted = False
            category, status, message = "configuration", 503, "The Gemini connection needs administrator attention."
        except Exception as exc:
            category, status, message = provider_failure(exc)
    settle(request_id, started, generation_attempted, response, category)
    if category:
        return status, {"error": message, "request_id": request_id, "retryable_attempt": True}
    return 200, {"reply": reply.strip(), "request_id": request_id}


class handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            if self.headers.get_content_type() != "application/json":
                raise ApiError(415, "Send the chat request as JSON.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 60_000:
                raise ApiError(400, "Invalid chat request size.")
            status, payload = chat(self.headers, json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeError, RecursionError):
            status, payload = 400, {"error": "Invalid JSON request."}
        except ApiError as exc:
            status, payload = exc.status, {"error": exc.message}
        except Exception:
            # Never log exception bodies, API keys, conversation text or bearer tokens.
            status, payload = 503, {"error": "AI chat is temporarily unavailable."}
        self.send_json(status, payload)

    def do_GET(self):
        self.send_json(405, {"error": "Use POST to send a chat message."})

    def log_message(self, format, *args):
        return
