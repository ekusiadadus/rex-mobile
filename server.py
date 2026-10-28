#!/usr/bin/env python3
"""Private, loopback-only Rex bridge behind Tailscale Serve."""
import json
import os
import re
import subprocess
import selectors
import shutil
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
REX = os.environ.get("REX_BIN") or shutil.which("rex") or str(Path.home() / "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex")
ORIGIN = os.environ.get("REX_MOBILE_ORIGIN", "")
OWNER = os.environ.get("REX_MOBILE_OWNER", "")
KEYS = {"enter", "tab", "escape", "up", "down", "left", "right", "backspace", "ctrl+c", "ctrl+d"}
COMMANDS = threading.BoundedSemaphore(4)
INPUT_LOCK = threading.Lock()

class TargetUnavailable(RuntimeError):
    pass

def rex(*args, raw=False):
    env = {k: v for k, v in os.environ.items() if not k.startswith("REX_")}
    with COMMANDS:
        with subprocess.Popen([REX, "--autostart=false", "--timeout=8s", *args],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as proc:
            output, errors = bytearray(), bytearray()
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ, output)
                sel.register(proc.stderr, selectors.EVENT_READ, errors)
                deadline = time.monotonic() + 12
                try:
                    while sel.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise RuntimeError("Rex timeout")
                        for key, _ in sel.select(min(remaining, 1)):
                            chunk = os.read(key.fileobj.fileno(), 65536)
                            if not chunk:
                                sel.unregister(key.fileobj)
                            else:
                                key.data.extend(chunk)
                                if len(output) + len(errors) > 2 * 1024 * 1024:
                                    raise RuntimeError("Rex response too large")
                    code = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
                except BaseException:
                    proc.kill()
                    proc.wait()
                    raise
            if code == 3:
                raise TargetUnavailable("対象のセッションまたは端末は終了しました")
            if code:
                raise RuntimeError("Rex が応答しません。対象のセッション・ペインを選び直してください。")
    result = output.decode("utf-8")
    return result if raw else json.loads(result)

def configuration_valid():
    origin = urlsplit(ORIGIN)
    return bool(OWNER and origin.scheme == "https" and origin.hostname
                and not origin.username and not origin.password
                and not origin.path and not origin.query and not origin.fragment)

def target(data):
    s, b = data.get("session", ""), data.get("block", "")
    for value, prefix in [(s, "session"), (b, "block")]:
        if not isinstance(value, str) or not re.fullmatch(prefix + r":[0-9a-f-]{36}", value):
            raise ValueError("対象の ID が不正です")
    return s, b

def screen(s, b):
    result = rex("block", "call", "-s", s, "-b", b, "format",
                 json.dumps({"format": "text", "trim": True, "max_bytes": 131072}))
    text = result["content"]
    truncated = "id" in result
    if truncated:
        # Read only the recent tail from the same immutable capture.
        tail = rex("block", "call", "-s", s, "-b", b, "blob_read",
                   json.dumps({"id": result["id"], "offset": max(0, result["total"] - 32768), "max_bytes": 262144}))
        text = tail["data"]
    return {"text": text, "truncated": truncated}

def terminal_snapshot(s, b):
    # Full VT redraws must never be truncated or appended as output deltas.
    for attempt in range(2):
        before = rex("block", "call", "-s", s, "-b", b, "size", "{}")
        result = rex("block", "call", "-s", s, "-b", b, "format", json.dumps({
            "format": "vt", "extra_cursor": True, "extra_modes": True,
            "extra_style": True, "extra_scrolling_region": True,
            "extra_keyboard": True, "extra_kitty_keyboard": True,
            "max_bytes": 262144}))
        parts = [result["content"]]
        offset = len(parts[0].encode("utf-8"))
        if result.get("total", offset) > 4 * 1024 * 1024:
            raise RuntimeError("terminal snapshot too large")
        while "id" in result and offset < result["total"]:
            chunk = rex("block", "call", "-s", s, "-b", b, "blob_read", json.dumps({
                "id": result["id"], "offset": offset, "max_bytes": 262144}))
            data = chunk["data"]
            if not data:
                raise RuntimeError("incomplete terminal snapshot")
            parts.append(data)
            offset += len(data.encode("utf-8"))
        after = rex("block", "call", "-s", s, "-b", b, "size", "{}")
        if (before["columns"], before["rows"]) == (after["columns"], after["rows"]):
            vt = "".join(parts)
            # VT is an ordered terminal program. Preserve every byte; removing
            # a row separator moves a populated bottom row into the previous row.
            return {"vt": vt, "columns": after["columns"], "rows": after["rows"], "transport": "snapshot"}
    raise RuntimeError("terminal size changing")

class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.connections = threading.BoundedSemaphore(32)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        pass  # Never persist terminal contents, targets, or user input.

    def respond(self, code, data, content_type="application/json; charset=utf-8"):
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        # Serve strips incoming identity headers and supplies its verified identity.
        if not configuration_valid():
            self.respond(503, {"error": "Server configuration is required"})
            return False
        if self.headers.get("Host") != urlsplit(ORIGIN).netloc:
            self.respond(403, {"error": "接続先が不正です"})
            return False
        if self.headers.get("Tailscale-User-Login") != OWNER:
            self.respond(403, {"error": "所有者の Tailscale アカウントで接続してください"})
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "none", "same-origin"):
            self.respond(403, {"error": "外部サイトからのアクセスは拒否しました"})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        try:
            url = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path == "/api/sessions":
                result = rex("ls", "--json")
                return self.respond(200, {"sessions": [{"session_id": s["session_id"], "label": s.get("label", "")} for s in result["sessions"]]})
            if url.path == "/api/blocks":
                s = q.get("session", "")
                if not re.fullmatch(r"session:[0-9a-f-]{36}", s):
                    raise ValueError("セッションを選択してください")
                rows = rex("block", "ls", "-s", s, "--json")["blocks"]
                return self.respond(200, {"blocks": [{k: row.get(k, "") for k in ("block_id", "label", "window_id")} for row in rows if row.get("creator_name") == "com.superlogical.terminal"]})
            if url.path == "/api/terminal":
                return self.respond(200, terminal_snapshot(*target(q)))
            if url.path == "/api/screen":
                return self.respond(200, screen(*target(q)))
            if url.path.startswith("/static/vendor/") or url.path == "/static/terminal.js":
                relative = url.path.removeprefix("/static/")
                path = (ROOT / "static" / relative).resolve()
                if not path.is_relative_to((ROOT / "static").resolve()) or not path.is_file():
                    return self.respond(404, {"error": "Not found"})
                mime = "application/wasm" if path.suffix == ".wasm" else "text/javascript; charset=utf-8"
                return self.respond(200, path.read_bytes(), mime)
            files = {"/": ("index.html", "text/html; charset=utf-8"), "/static/app.js": ("app.js", "text/javascript; charset=utf-8"), "/static/style.css": ("style.css", "text/css; charset=utf-8")}
            if url.path in files:
                name, mime = files[url.path]
                return self.respond(200, (ROOT / "static" / name).read_bytes(), mime)
            self.respond(404, {"error": "Not found"})
        except TargetUnavailable:
            self.respond(404, {"error": "対象のセッションまたは端末は終了しました。更新して選び直してください。"})
        except ValueError as e:
            self.respond(400, {"error": str(e)})
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            self.respond(502, {"error": "Rex との通信に失敗しました。更新して再接続してください。"})
        except Exception:
            self.respond(500, {"error": "読み込みに失敗しました"})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/api/input":
            return self.respond(404, {"error": "Not found"})
        if self.headers.get("Origin") != ORIGIN or self.headers.get("Content-Type") != "application/json":
            return self.respond(403, {"error": "入力元を確認できません"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n < 1 or n > 16384:
                raise ValueError("入力が長すぎます")
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict):
                raise ValueError("入力形式が不正です")
            s, b = target(data)
            submit = False
            if set(data) == {"session", "block", "terminal_data"}:
                value = data["terminal_data"]
                if not isinstance(value, str) or not value or len(value.encode()) > 8192 or "\x00" in value:
                    raise ValueError("端末入力が不正です")
                args = ("send", "-s", s, "-b", b, "--", value)
            elif set(data) in ({"session", "block", "text"}, {"session", "block", "text", "submit"}):
                submit = data.get("submit", False)
                if not isinstance(submit, bool):
                    raise ValueError("submit は真偽値が必要です")
                text = data["text"]
                if not isinstance(text, str) or not text or len(text.encode()) > 8192:
                    raise ValueError("文字を入力してください（最大 8 KB）")
                # Textarea Return often leaves trailing line breaks. Never turn them into execution.
                text = text.rstrip("\r\n")
                if not text:
                    raise ValueError("文字を入力してください")
                # Embedded newlines/control keys still need explicit terminal handling.
                if any(ord(c) < 32 or ord(c) == 127 for c in text):
                    raise ValueError("改行・制御文字は送信できません。Enter ボタンを使ってください")
                args = ("send", "-s", s, "-b", b, "--", text)
            elif set(data) == {"session", "block", "key"} and data["key"] in KEYS:
                args = ("send-key", "-s", s, "-b", b, data["key"])
            else:
                raise ValueError("入力形式が不正です")
            with INPUT_LOCK:
                rex(*args, raw=True)
                if submit:
                    rex("send-key", "-s", s, "-b", b, "enter", raw=True)
            self.respond(200, {"ok": True, "submitted": submit})
        except TargetUnavailable:
            self.respond(404, {"error": "対象のセッションまたは端末は終了しました。更新して選び直してください。"})
        except (ValueError, TypeError):
            self.respond(400, {"error": "空の入力・途中の改行・制御文字は送信できません。1行で入力し、実行は Enter ボタンを使ってください。"})
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            self.respond(502, {"error": "文字または Enter の送信結果を確認できません。文字だけ届いている可能性もあります。画面を確認してください。自動再送はしていません。"})

if __name__ == "__main__":
    if not configuration_valid():
        raise SystemExit("Set REX_MOBILE_ORIGIN to an HTTPS origin and REX_MOBILE_OWNER to your Tailscale login.")
    BoundedHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
