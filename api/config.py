
import json
from http.server import BaseHTTPRequestHandler

from api.shared.supabase import ApiError, configuration


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            supabase_url, supabase_key = configuration()
            status = 200
            response = {"supabaseUrl": supabase_url, "supabaseKey": supabase_key}
        except ApiError as exc:
            status = exc.status
            response = {"error": exc.message}
        raw = json.dumps(response).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)
