"""Run MannSathi locally: python local_test.py  ->  http://127.0.0.1:8000

Serves the static pages and routes:
  POST /api/chat   -> api/chat.py
  GET  /api/config -> api/config.py
  GET/POST/PATCH/DELETE /api/calendar -> api/calendar.py
  GET/POST/PATCH/DELETE /api/tasks -> api/tasks.py
  GET/POST/PATCH /api/focus -> api/focus.py
  GET/POST /api/admin -> api/admin.py
Reads GEMINI_API_KEY / GEMINI_MODEL / SUPABASE_* from a .env file in this folder.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

env_path = os.path.join(ROOT, ".env")
if os.path.exists(env_path):
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))

from api.chat import handler as ChatHandler  # noqa: E402
from api.config import handler as ConfigHandler  # noqa: E402
from api.calendar import dispatch as calendar_dispatch  # noqa: E402
from api.tasks import dispatch as tasks_dispatch  # noqa: E402
from api.focus import dispatch as focus_dispatch  # noqa: E402
from api.admin import dispatch as admin_dispatch  # noqa: E402


PUBLIC_PAGES = {"index.html", "app.html", "signup.html", "teacher-login.html", "admin.html"}
PUBLIC_ASSETS = {"css": {".css"}, "js": {".js"}, "images": {".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif"}}


def public_file(url, root):
    """Map both GET and HEAD to known public files, including after symlink resolution."""
    try:
        location = unquote(urlsplit(url).path, errors="strict")
        if location == "/":
            location = "/index.html"
        if not location.startswith("/"):
            return None
        parts = location[1:].split("/")
        if any(not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", p) or p.endswith(".") for p in parts):
            return None
        base = Path(root).resolve()
        candidate = base.joinpath(*parts).resolve(strict=True)
        if not candidate.is_file():
            return None
        if len(parts) == 1:
            return candidate if parts[0] in PUBLIC_PAGES and candidate == base / parts[0] else None
        area = parts[0]
        if (area in PUBLIC_ASSETS and candidate.is_relative_to(base / area)
                and Path(parts[-1]).suffix.lower() in PUBLIC_ASSETS[area] and candidate.suffix.lower() in PUBLIC_ASSETS[area]):
            return candidate
    except (ValueError, OSError, RuntimeError):
        pass
    return None


class LocalHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = public_file(self.path, ROOT)
        if path is None:
            self.send_error(404)
            return None
        try:
            stream = path.open("rb")
        except OSError:
            self.send_error(404)
            return None
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        return stream

    def do_POST(self):
        if self.path.split("?")[0] == "/api/admin":
            return admin_dispatch(self, "POST")
        if self.path.split("?")[0] == "/api/focus":
            return focus_dispatch(self, "POST")
        if self.path.split("?")[0] == "/api/tasks":
            return tasks_dispatch(self, "POST")
        if self.path.split("?")[0] == "/api/calendar":
            return calendar_dispatch(self, "POST")
        if self.path.split("?")[0] == "/api/chat":
            return ChatHandler.do_POST(self)
        self.send_error(404)

    def send_json(self, status, payload):
        return ChatHandler.send_json(self, status, payload)

    def do_GET(self):
        clean_path = self.path.split("?")[0]
        if clean_path == "/api/admin":
            return admin_dispatch(self, "GET")
        if clean_path == "/api/focus":
            return focus_dispatch(self, "GET")
        if clean_path == "/api/tasks":
            return tasks_dispatch(self, "GET")
        if clean_path == "/api/calendar":
            return calendar_dispatch(self, "GET")
        if clean_path == "/api/chat":
            return ChatHandler.do_GET(self)
        if clean_path == "/api/config":
            return ConfigHandler.do_GET(self)
        return super().do_GET()

    def do_PATCH(self):
        if self.path.split("?")[0] == "/api/admin":
            return admin_dispatch(self, "PATCH")
        if self.path.split("?")[0] == "/api/focus":
            return focus_dispatch(self, "PATCH")
        if self.path.split("?")[0] == "/api/tasks":
            return tasks_dispatch(self, "PATCH")
        if self.path.split("?")[0] == "/api/calendar":
            return calendar_dispatch(self, "PATCH")
        self.send_error(404)

    def do_DELETE(self):
        if self.path.split("?")[0] == "/api/admin":
            return admin_dispatch(self, "DELETE")
        if self.path.split("?")[0] == "/api/focus":
            return focus_dispatch(self, "DELETE")
        if self.path.split("?")[0] == "/api/tasks":
            return tasks_dispatch(self, "DELETE")
        if self.path.split("?")[0] == "/api/calendar":
            return calendar_dispatch(self, "DELETE")
        self.send_error(404)

    def do_PUT(self):
        if self.path.split("?")[0] == "/api/admin":
            return admin_dispatch(self, "PUT")
        if self.path.split("?")[0] == "/api/focus":
            return focus_dispatch(self, "PUT")
        if self.path.split("?")[0] == "/api/tasks":
            return tasks_dispatch(self, "PUT")
        if self.path.split("?")[0] == "/api/calendar":
            return calendar_dispatch(self, "PUT")
        self.send_error(404)


if __name__ == "__main__":
    print("MannSathi running at http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), LocalHandler).serve_forever()
