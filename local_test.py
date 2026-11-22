"""Run MannSathi locally: python local_test.py  ->  http://127.0.0.1:8000

Serves the static pages and routes:
  POST /api/chat   -> api/chat.py
  GET  /api/config -> api/config.py
Reads GEMINI_API_KEY / GEMINI_MODEL / SUPABASE_* from a .env file in this folder.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

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


class LocalHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path.split("?")[0] == "/api/chat":
            return ChatHandler.do_POST(self)
        self.send_error(404)

    def send_json(self, status, payload):
        return ChatHandler.send_json(self, status, payload)

    def do_GET(self):
        clean_path = self.path.split("?")[0]
        if clean_path == "/api/chat":
            return ChatHandler.do_GET(self)
        if clean_path == "/api/config":
            return ConfigHandler.do_GET(self)
        return super().do_GET()


if __name__ == "__main__":
    print("MannSathi running at http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), LocalHandler).serve_forever()
