#!/usr/bin/env python3
"""VidFetch server — stdlib HTTP server with a small JSON API.

Endpoints
---------
GET  /                       -> app (static/index.html)
GET  /<asset>                -> static asset (style.css, app.js, favicon…)
GET  /api/info?url=<url>     -> video metadata (no download)
POST /api/download           -> start a job  {url, kind, quality}
GET  /api/jobs               -> every job (poll this for progress)
POST /api/jobs/<id>/cancel   -> cancel a running job
DELETE /api/jobs/<id>        -> forget a finished job + delete its files
GET  /api/file/<jobid>/<idx> -> stream a finished file (attachment)
"""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import downloader as dl

log = logging.getLogger("vidfetch")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

MANAGER = dl.DownloadManager()

# --------------------------------------------------------------------------- #
# Static index page & assets
# --------------------------------------------------------------------------- #
def _load_index() -> bytes:
    try:
        with open(os.path.join(STATIC_DIR, "index.html"), "rb") as fh:
            return fh.read()
    except OSError:
        return b"<h1>VidFetch: static/index.html is missing</h1>"


INDEX_HTML = _load_index()

_NO_CACHE = {"Cache-Control": "no-cache"}
_STATIC_CACHE = {"Cache-Control": "public, max-age=3600"}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "VidFetch/1.0"
    protocol_version = "HTTP/1.1"
    daemon_threads = True  # don't block shutdown on in-flight requests

    # Keep request logs quiet (progress polling is chatty)
    def log_message(self, fmt, *args):  # noqa: N802
        log.debug(fmt, *args)

    # -- routing ----------------------------------------------------------- #
    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._send_bytes(200, INDEX_HTML, "text/html; charset=utf-8",
                                        _NO_CACHE)
            if path.startswith("/api/"):
                return self._handle_api_get(path)
            served = self._serve_static(path)
            if served:
                return
            self._send_json(404, {"ok": False, "error": "Not found."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # safety net: never crash the server
            log.exception("GET %s failed", path)
            try:
                self._send_json(500, {"ok": False, "error": f"Server error: {exc}"})
            except Exception:
                pass

    def do_POST(self):  # noqa: N802
        try:
            body = self._read_json_body()
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/download":
                return self._api_download(body)
            if m := re.fullmatch(r"/api/jobs/([0-9a-f]+)/cancel", path):
                job = MANAGER.get(m.group(1))
                if not job:
                    return self._send_json(404, {"ok": False,
                                                 "error": "Unknown job."})
                ok = MANAGER.cancel(job.id)
                return self._send_json(200, {"ok": ok, "id": job.id})
            self._send_json(404, {"ok": False, "error": "Not found."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log.exception("POST %s failed", self.path)
            try:
                self._send_json(500, {"ok": False, "error": f"Server error: {exc}"})
            except Exception:
                pass

    def do_DELETE(self):  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path).path
            if m := re.fullmatch(r"/api/jobs/([0-9a-f]+)", path):
                ok = MANAGER.delete(m.group(1))
                if not ok:
                    return self._send_json(404, {"ok": False,
                                                 "error": "Job not found or still running."})
                return self._send_json(200, {"ok": True})
            self._send_json(404, {"ok": False, "error": "Not found."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log.exception("DELETE %s failed", self.path)
            try:
                self._send_json(500, {"ok": False, "error": f"Server error: {exc}"})
            except Exception:
                pass

    # -- API --------------------------------------------------------------- #
    def _handle_api_get(self, path: str):
        if path == "/api/jobs":
            return self._send_json(200, {"ok": True, "jobs": MANAGER.list_jobs()})
        if path == "/api/info":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw = (qs.get("url") or [""])[0]
            if not raw.strip():
                return self._send_json(400, {"ok": False, "error": "Missing url."})
            url = dl._sanitize_url(raw)
            blocked, reason = dl.ssrf_blocked(url)
            if blocked:
                return self._send_json(403, {"ok": False, "error": reason})
            try:
                return self._send_json(200, MANAGER.info(url))
            except dl.yt_dlp.utils.DownloadError as exc:
                return self._send_json(
                    422, {"ok": False,
                          "error": str(exc).splitlines()[0][:400]})
            except dl.yt_dlp.utils.ExtractorError as exc:
                return self._send_json(
                    422, {"ok": False, "error": f"Extractor error: {exc}"})
            except Exception as exc:  # noqa: BLE001
                log.exception("info failed for %r", raw)
                return self._send_json(500, {"ok": False,
                                             "error": f"Could not read URL: {exc}"})
        if m := re.fullmatch(r"/api/jobs/([0-9a-f]+)", path):
            job = MANAGER.get(m.group(1))
            if not job:
                return self._send_json(404, {"ok": False, "error": "Unknown job."})
            return self._send_json(200, {"ok": True, "job": job.public()})
        if m := re.fullmatch(r"/api/file/([0-9a-f]+)/(\d+)", path):
            return self._serve_job_file(m.group(1), int(m.group(2)))
        self._send_json(404, {"ok": False, "error": "Not found."})

    def _api_download(self, body: dict):
        raw = (body.get("url") or "").strip()
        if not raw:
            return self._send_json(400, {"ok": False, "error": "Missing url."})
        url = dl._sanitize_url(raw)
        blocked, reason = dl.ssrf_blocked(url)
        if blocked:
            return self._send_json(403, {"ok": False, "error": reason})
        kind = body.get("kind") or "video"
        quality = str(body.get("quality") or ("best" if kind == "video" else "auto"))
        if kind not in ("video", "audio"):
            return self._send_json(400, {"ok": False, "error": "Bad kind."})
        if kind == "video" and quality not in dl.VIDEO_QUALITIES:
            return self._send_json(400, {"ok": False, "error": "Bad quality."})
        if kind == "audio" and quality not in dl.AUDIO_CODECS:
            return self._send_json(400, {"ok": False, "error": "Bad codec."})
        job = MANAGER.create_job(url, kind, quality)
        return self._send_json(200, {"ok": True, "job": job.public()})

    # -- static / files ---------------------------------------------------- #
    def _serve_static(self, path: str) -> bool:
        if path == "/favicon.ico":
            path = "/favicon.svg"
        rel = path.lstrip("/")
        if not rel or ".." in rel.replace("\\", "/").split("/"):
            return False
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep):
            return False
        if not os.path.isfile(full):
            return False
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1],
                                  mimetypes.guess_type(full)[0] or "application/octet-stream")
        with open(full, "rb") as fh:
            self._send_bytes(200, fh.read(), ctype, _STATIC_CACHE)
        return True

    def _serve_job_file(self, job_id: str, idx: int):
        job = MANAGER.get(job_id)
        if not job:
            return self._send_json(404, {"ok": False, "error": "Unknown job."})
        if not (0 <= idx < len(job.files)):
            return self._send_json(404, {"ok": False, "error": "No such file."})
        fref = job.files[idx]
        if fref.kind == "thumb":
            ctype, disp = "image/jpeg", "inline"
        else:
            name_l = str(fref.name).lower()
            if name_l.endswith(".mp3"):
                ctype = "audio/mpeg"
            elif name_l.endswith((".mp4", ".m4v", ".mov")):
                ctype = "video/mp4"
            elif name_l.endswith(".webm"):
                ctype = "video/webm"
            else:
                ctype = "application/octet-stream"
            disp = "attachment"
        if not os.path.isfile(fref.path) or not os.path.realpath(fref.path).startswith(
                os.path.realpath(dl.DOWNLOAD_DIR) + os.sep):
            return self._send_json(404, {"ok": False, "error": "File missing."})
        size = os.path.getsize(fref.path)
        ascii_name = re.sub(r"[^\x20-\x7e]", "_", fref.name)
        quoted = urllib.parse.quote(fref.name)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header(
            "Content-Disposition",
            f'{disp}; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}')
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(fref.path, "rb") as fh:
            while chunk := fh.read(1024 * 1024):
                self.wfile.write(chunk)

    # -- helpers ----------------------------------------------------------- #
    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        length = min(length, 1_000_000)  # cap request bodies at 1 MB
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(code, body, "application/json; charset=utf-8",
                         {"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})

    def _send_bytes(self, code: int, body: bytes, ctype: str, headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="VidFetch — yt-dlp powered downloader")
    ap.add_argument("--host", default=os.environ.get("VIDFETCH_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("VIDFETCH_PORT", "8000")))
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{'localhost' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    print(f"\n  VidFetch is running at {url}\n"
          f"  Downloads are stored in {os.path.abspath(dl.DOWNLOAD_DIR)}\n"
          f"  Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()