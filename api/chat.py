
import json
import os
from http.server import BaseHTTPRequestHandler

from google import genai
from google.genai import types

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


class handler(BaseHTTPRequestHandler):

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8"
        )
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            # Read and validate the API key.
            api_key = os.environ.get("GEMINI_API_KEY")

            if not api_key:
                self.send_json(
                    500,
                    {"error": "MannSathi is not configured yet."}
                )
                return

            content_length = int(
                self.headers.get("Content-Length", "0")
            )

            if content_length <= 0 or content_length > 60000:
                self.send_json(
                    400,
                    {"error": "Invalid request size."}
                )
                return

            raw_body = self.rfile.read(content_length)
            body = json.loads(raw_body)

            if not isinstance(body, dict):
                self.send_json(
                    400,
                    {"error": "Invalid request format."}
                )
                return

            messages = body.get("messages")

            if (
                not isinstance(messages, list)
                or not messages
                or len(messages) > 12
            ):
                self.send_json(
                    400,
                    {"error": "Please send a valid conversation."}
                )
                return

            contents = []

            for message in messages:
                if not isinstance(message, dict):
                    self.send_json(
                        400,
                        {"error": "Invalid message format."}
                    )
                    return

                role = message.get("role")
                text = message.get("text")

                if (
                    role not in ("user", "assistant")
                    or not isinstance(text, str)
                    or not text.strip()
                    or len(text) > 4000
                ):
                    self.send_json(
                        400,
                        {"error": "Invalid message content."}
                    )
                    return

                contents.append({
                    "role": (
                        "user" if role == "user" else "model"
                    ),
                    "parts": [{"text": text.strip()}]
                })

            if contents[-1]["role"] != "user":
                self.send_json(
                    400,
                    {
                        "error":
                        "The latest message must be from the user."
                    }
                )
                return

            print(
                "MannSathi: Starting Gemini request...",
                flush=True
            )

            # Create the client inside try so initialization errors
            # are handled by the exception handler below.
            print("MannSathi: Initializing Gemini client...", flush=True)

            client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(timeout=120000)
            )

            print("MannSathi: Gemini client initialized.", flush=True)
            response = client.models.generate_content(
                model=os.environ.get(
                    "GEMINI_MODEL",
                    "gemini-3.5-flash-lite"
                ),
                contents=contents,
                config={
                    "system_instruction": SYSTEM_INSTRUCTION,
                    "temperature": 0.7,
                    "max_output_tokens": 250
                }
            )

            print(
                "MannSathi: Gemini request completed.",
                flush=True
            )

            reply = response.text

            if not reply or not reply.strip():
                self.send_json(
                    502,
                    {
                        "error":
                        "MannSathi could not generate a response."
                    }
                )
                return

            self.send_json(200, {"reply": reply.strip()})

        except json.JSONDecodeError:
            self.send_json(
                400,
                {"error": "Invalid JSON request."}
            )

        except Exception as exc:
            # Detailed errors stay in the local terminal.
            # Never return exception details or API keys to visitors.
            print(
                f"MannSathi backend error: "
                f"{type(exc).__name__}: {exc}",
                flush=True
            )

            try:
                self.send_json(
                    502,
                    {
                        "error":
                        "Unable to respond right now. Please try again."
                    }
                )
            except (BrokenPipeError, ConnectionResetError, OSError):
                print(
                    "MannSathi: Client disconnected before response.",
                    flush=True
                )

    def do_GET(self):
        self.send_json(
            405,
            {"error": "Use POST to send a chat message."}
        )

    def log_message(self, format, *args):
        # Avoid logging request details that might contain sensitive data.
        return
