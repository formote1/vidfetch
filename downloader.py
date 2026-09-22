"""YouTube-style video/audio download engine built on yt-dlp + ffmpeg.

Pure standard library + the already-installed `yt_dlp` package. No web
framework required. Downloads run in background threads with a concurrency
limit, and progress is exposed via a polling-friendly snapshot API.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import yt_dlp

log = logging.getLogger("downloader")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.join(BASE_DIR, "downloads")

# Tune via environment variables
MAX_CONCURRENT = int(os.environ.get("VIDFETCH_MAX_CONCURRENT", "2"))
BLOCK_PRIVATE_IPS = os.environ.get("VIDFETCH_BLOCK_PRIVATE_IPS", "1") == "1"
FFMPEG_LOCATION = os.environ.get("VIDFETCH_FFMPEG", None) or None

VIDEO_QUALITIES = ("best", "2160", "1440", "1080", "720", "480", "360")
AUDIO_CODECS = ("auto", "mp3", "m4a", "opus", "flac")

MEDIA_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".mp3", ".m4a",
              ".opus", ".flac", ".wav", ".aac", ".ogg", ".oga", ".wma"}

# statuses a Job can be in
ST_QUEUED = "queued"
ST_DOWNLOADING = "downloading"
ST_PROCESSING = "processing"
ST_DONE = "done"
ST_ERROR = "error"
ST_CANCELED = "canceled"

PP_LABELS = {
    "FFmpegMerger": "Merging video & audio into MP4…",
    "FFmpegExtractAudio": "Extracting / converting audio…",
    "EmbedThumbnail": "Embedding cover art…",
    "FFmpegMetadata": "Writing metadata…",
    "FFmpegVideoRemuxer": "Re-muxing into MP4…",
    "MoveFiles": "Finalizing…",
}


def _is_private_ip(ip: str) -> bool:
    """True for loopback / private / link-local / reserved / unspecified addresses."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified)


def ssrf_blocked(url: str) -> tuple[bool, str]:
    """Light SSRF guard.

    Always refuses non-http(s) URLs. When BLOCK_PRIVATE_IPS is enabled it also
    refuses hosts that only resolve to private/local addresses (mixed address
    sets from CDNs are allowed). Returns (blocked, reason).
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return True, "Only http/https URLs are allowed."
    if not BLOCK_PRIVATE_IPS:
        return False, ""
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        return False, ""  # DNS failure: let yt-dlp surface the real error
    ips = {info[4][0] for info in infos}
    private = [ip for ip in ips if _is_private_ip(ip)]
    public = [ip for ip in ips if not _is_private_ip(ip)]
    if private and not public:
        return True, f"Refusing {parsed.hostname}: resolves only to private/local addresses."
    return False, ""


def _sanitize_url(url: str) -> str:
    url = url.strip()
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme:
        url = "https://" + url
    return url


@dataclass
class FileRef:
    name: str
    path: str
    size: int
    kind: str  # "video" | "audio" | "thumb" | "other"


@dataclass
class Job:
    id: str
    url: str
    kind: str               # "video" | "audio"
    quality: str            # height ("1080") or codec ("mp3")
    created: float
    status: str = ST_QUEUED
    phase: str = "Waiting for a free slot…"
    progress: float = 0.0
    speed: Optional[float] = None
    eta: Optional[float] = None
    downloaded_bytes: Optional[float] = None
    total_bytes: Optional[float] = None
    error: Optional[str] = None
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[float] = None
    duration_string: Optional[str] = None
    uploader: Optional[str] = None
    source_url: Optional[str] = None
    max_height: Optional[int] = None
    files: list = field(default_factory=list)
    directory: Optional[str] = None

    # internal
    _cancel: bool = field(default=False, repr=False)
    _parts: list = field(default_factory=list, repr=False)  # [{label, done, total, ratio}]
    _current_part_idx: int = field(default=-1, repr=False)

    def public(self) -> dict:
        return {
            "id": self.id,
            "url": self.url,
            "kind": self.kind,
            "quality": self.quality,
            "created": self.created,
            "status": self.status,
            "phase": self.phase,
            "progress": round(self.progress, 1),
            "speed": self.speed,
            "eta": self.eta,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "error": self.error,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "duration": self.duration,
            "duration_string": self.duration_string,
            "uploader": self.uploader,
            "source_url": self.source_url,
            "max_height": self.max_height,
            "files": [f.__dict__ for f in self.files],
        }


class DownloadManager:
    def __init__(self, max_concurrent: int = MAX_CONCURRENT,
                 download_dir: str = DOWNLOAD_DIR):
        self.download_dir = download_dir
        os.makedirs(self.download_dir, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(max_concurrent)
        self._load_existing()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def create_job(self, url: str, kind: str, quality: str) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            url=url,
            kind=kind if kind in ("video", "audio") else "video",
            quality=quality,
            created=time.time(),
        )
        with self._lock:
            self._jobs[job.id] = job
        threading.Thread(target=self._worker, args=(job,), daemon=True).start()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        jobs.sort(key=lambda j: j.created, reverse=True)
        return [j.public() for j in jobs]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job or job.status in (ST_DONE, ST_ERROR, ST_CANCELED):
            return False
        job._cancel = True
        return True

    def delete(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        if job.status not in (ST_DONE, ST_ERROR, ST_CANCELED):
            return False
        with self._lock:
            self._jobs.pop(job_id, None)
        if job.directory and os.path.isdir(job.directory):
            shutil.rmtree(job.directory, ignore_errors=True)
        return True

    def info(self, url: str) -> dict:
        """Lightweight metadata fetch (no download)."""
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "extract_flat": "in_playlist",
            "socket_timeout": 20,
            "noprogress": True,
            "skip_download": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not info:
            return {"ok": False, "error": "Could not read this URL."}
        if info.get("_type") == "playlist":
            entries = [e for e in info.get("entries") or [] if e]
            if not entries:
                return {"ok": False, "error": "Playlist contains no videos."}
            info = entries[0]
        return {
            "ok": True,
            "title": info.get("title") or "Untitled",
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "duration_string": duration_string(info.get("duration")),
            "uploader": info.get("uploader") or info.get("channel") or info.get("creator"),
            "webpage_url": info.get("webpage_url") or info.get("original_url") or url,
            "height": info.get("height"),
            "is_live": bool(info.get("is_live")),
        }

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #
    def _load_existing(self):
        """Rebuild 'done' jobs from previous runs by scanning download dirs."""
        if not os.path.isdir(self.download_dir):
            return
        with self._lock:
            for name in os.listdir(self.download_dir):
                meta_path = os.path.join(self.download_dir, name, "meta.json")
                if not os.path.isfile(meta_path):
                    continue
                try:
                    with open(meta_path, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                except (OSError, ValueError):
                    continue
                job = Job(
                    id=data.get("id", name),
                    url=data.get("url", ""),
                    kind=data.get("kind", "video"),
                    quality=data.get("quality", ""),
                    created=data.get("created", 0),
                    status=ST_DONE,
                    phase="Finished",
                    progress=100.0,
                    title=data.get("title"),
                    thumbnail=data.get("thumbnail"),
                    duration=data.get("duration"),
                    duration_string=data.get("duration_string"),
                    uploader=data.get("uploader"),
                    source_url=data.get("source_url"),
                    max_height=data.get("max_height"),
                    directory=data.get("directory"),
                    files=[FileRef(**f) for f in data.get("files", [])],
                )
                # guard against stale dirs that no longer exist
                if job.directory and not os.path.isdir(job.directory):
                    continue
                self._jobs[job.id] = job
        log.info("Restored %d previous download(s)", len(self._jobs))

    def _save_meta(self, job: Job):
        if not job.directory:
            return
        try:
            os.makedirs(job.directory, exist_ok=True)
            payload = job.public()
            payload["directory"] = job.directory
            payload["files"] = [f.__dict__ for f in job.files]
            with open(os.path.join(job.directory, "meta.json"), "w",
                      encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
        except OSError as exc:
            log.warning("Could not write meta.json: %s", exc)

    def _worker(self, job: Job):
        """Respects the concurrency limit, then runs the download."""
        with self._slots:
            if job._cancel:
                self._fail(job, ST_CANCELED, "Canceled")
                return
            job.status = ST_DOWNLOADING
            job.phase = "Contacting source…"
            try:
                self._execute(job)
            except yt_dlp.utils.DownloadCancelled:
                self._fail(job, ST_CANCELED, "Canceled")
            except yt_dlp.utils.DownloadError as exc:
                self._fail(job, ST_ERROR, str(exc).splitlines()[0][:300])
            except yt_dlp.utils.ExtractorError as exc:
                self._fail(job, ST_ERROR, f"Extractor error: {exc}")
            except (OSError, ValueError) as exc:
                self._fail(job, ST_ERROR, str(exc)[:300])
            except Exception as exc:  # pragma: no cover - safety net
                log.exception("Unexpected download failure")
                self._fail(job, ST_ERROR, f"Unexpected error: {exc}")

    def _fail(self, job: Job, status: str, message: str):
        job.status = status
        job.error = message
        job.phase = message
        job.speed = None
        job.eta = None
        if status in (ST_ERROR, ST_CANCELED):
            shutil.rmtree(job.directory, ignore_errors=True) if job.directory else None
            job.directory = None
        log.info("Job %s -> %s: %s", job.id, status, message)

    def _execute(self, job: Job):
        job.directory = os.path.join(self.download_dir, job.id)
        os.makedirs(job.directory, exist_ok=True)

        def progress_hook(d: dict):
            if job._cancel:
                raise yt_dlp.utils.DownloadCancelled()
            self._on_progress(job, d)

        def pp_hook(d: dict):
            if job._cancel:
                raise yt_dlp.utils.DownloadCancelled()
            if d.get("status") == "started":
                job.phase = PP_LABELS.get(d.get("postprocessor"), "Processing…")
                if job.status != ST_PROCESSING:
                    job.status = ST_PROCESSING
                    job.progress = 99.0

        opts: dict[str, Any] = {
            "outtmpl": os.path.join(job.directory, "%(title).170B [%(id)s].%(ext)s"),
            "format": self._format_spec(job),
            "merge_output_format": "mp4" if job.kind == "video" else None,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "continuedl": True,
            "socket_timeout": 30,
            "retries": 5,
            "fragment_retries": 5,
            "concurrent_fragment_downloads": 4,
            "writethumbnail": True,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [pp_hook],
        }
        if FFMPEG_LOCATION:
            opts["ffmpeg_location"] = FFMPEG_LOCATION

        if job.kind == "video":
            opts["postprocessors"] = [
                {"key": "EmbedThumbnail"},
                {"key": "FFmpegMetadata"},
            ]
        else:
            # "auto" resolves to M4A (lossless when the source is AAC, else
            # converted); other codecs pass straight through.
            acodec = job.quality if job.quality in ("mp3", "m4a", "opus", "flac") else "m4a"
            opts["postprocessors"] = [
                {"key": "FFmpegExtractAudio",
                 "preferredcodec": acodec,
                 "preferredquality": "192"},
                {"key": "EmbedThumbnail"},
            ]

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job.url, download=True)
            if info and info.get("_type") == "playlist":
                entries = info.get("entries") or []
                if entries:
                    info = entries[0]

        if job._cancel:
            raise yt_dlp.utils.DownloadCancelled()

        job.title = job.title or sanitize_title(info.get("title"))
        job.thumbnail = job.thumbnail or info.get("thumbnail")
        job.duration = info.get("duration")
        job.duration_string = duration_string(info.get("duration"))
        job.uploader = info.get("uploader") or info.get("channel") or info.get("creator")
        job.max_height = max(job.max_height or 0, info.get("height") or 0)

        self._collect_files(job)
        job.status = ST_DONE
        job.phase = "Finished"
        job.progress = 100.0
        job.speed = None
        job.eta = None
        self._save_meta(job)
        log.info("Job %s done: %d file(s)", job.id, len(job.files))

    @staticmethod
    def _format_spec(job: Job) -> str:
        if job.kind == "audio":
            q = job.quality
            if q == "mp3":
                return "bestaudio/best"
            if q in ("auto", "m4a"):
                return "bestaudio[ext=m4a]/bestaudio/best"
            if q == "opus":
                return "bestaudio[ext=webm]/bestaudio/best"
            if q == "flac":
                return "bestaudio[abr>320]/bestaudio/best"
            return "bestaudio/best"
        height = job.quality
        if height == "best":
            return "bv*+ba/b"
        try:
            h = int(height)
        except ValueError:
            h = 1080
        # Prefer video ≤ requested height + audio, but never fail: fall back to
        # the best available combination, then to a single combined file
        # (works for direct links where no height metadata exists).
        return (f"bv*[height<={h}]+ba/b[height<={h}]"
                "/bv*+ba/b"
                "/b")

    def _on_progress(self, job: Job, d: dict):
        status = d.get("status")
        if status == "downloading":
            info = d.get("info_dict") or {}
            label = self._part_label(info)
            idx = self._index_of_part(job, label)
            if idx < 0:
                job._parts.append({"label": label, "done": 0, "total": None})
                idx = len(job._parts) - 1
            part = job._parts[idx]
            frag_idx = d.get("fragment_index")
            frag_total = d.get("fragment_count")
            if frag_idx and frag_total:
                part["done"] = float(frag_idx) / float(frag_total)
                part["total"] = 1.0
            else:
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                done = d.get("downloaded_bytes") or 0
                part["done"] = float(done)
                if total:
                    part["total"] = float(total)
                elif done:
                    part["total"] = max(part["total"] or 0, done)
            job._current_part_idx = idx
            job.status = ST_DOWNLOADING
            job.phase = f"Downloading {label}…"
            job.speed = d.get("speed")
            job.eta = d.get("eta")
            self._update_bytes(job)
            job.progress = self._overall_progress(job)
        elif status == "finished":
            idx = job._current_part_idx
            if idx >= 0 and idx < len(job._parts):
                part = job._parts[idx]
                part["total"] = part["done"] or 1.0
                part["done"] = part["total"]
            job.speed = None
            job.eta = None
            self._update_bytes(job)
            if job.status != ST_PROCESSING:
                job.phase = "Processing…"
                job.progress = self._overall_progress(job)

    def _update_bytes(self, job: Job):
        """Aggregate downloaded/total bytes across all download parts."""
        done = 0.0
        total = 0.0
        for part in job._parts:
            d = part.get("done") or 0.0
            t = part.get("total") or d
            done += d
            total += t
        job.downloaded_bytes = done
        job.total_bytes = total

    @staticmethod
    def _part_label(info: dict) -> str:
        vcodec = info.get("vcodec")
        acodec = info.get("acodec")
        if vcodec and vcodec != "none":
            return "video"
        if acodec and acodec != "none":
            return "audio"
        return "media"

    def _index_of_part(self, job: Job, label: str) -> int:
        """Reuse the last unfinished part with this label, else signal 'new part'."""
        for i in range(len(job._parts) - 1, -1, -1):
            part = job._parts[i]
            if part["label"] == label and (
                    part["total"] is None or part["done"] < part["total"]):
                return i
        return -1

    def _overall_progress(self, job: Job) -> float:
        parts = job._parts
        if not parts:
            return 0.0
        total_weight, done_weight = 0.0, 0.0
        n = len(parts)
        for part in parts:
            w = 1.0 / n
            total_weight += w
            if part["total"]:
                ratio = min(1.0, part["done"] / part["total"])
            else:
                ratio = 0.0
            done_weight += w * ratio
        pct = (done_weight / total_weight) * 100.0 if total_weight else 0.0
        return min(98.0, max(0.0, pct))

    def _collect_files(self, job: Job):
        if not job.directory or not os.path.isdir(job.directory):
            return
        job.files = []
        for name in sorted(os.listdir(job.directory)):
            if name == "meta.json":
                continue
            full = os.path.join(job.directory, name)
            if not os.path.isfile(full):
                continue
            if name.lower().endswith((".part", ".ytdl", ".temp.mp4", ".temp.mkv")):
                continue
            ext = os.path.splitext(name)[1].lower()
            size = os.path.getsize(full)
            if ext in MEDIA_EXTS:
                kind = "audio" if job.kind == "audio" else "video"
            elif ext in (".jpg", ".jpeg", ".png", ".webp"):
                kind = "thumb"
                size = -1  # don't surface thumb size
            else:
                kind = "other"
            job.files.append(FileRef(name=name, path=full, size=size, kind=kind))


def sanitize_title(title) -> str:
    if not title:
        return "video"
    return re.sub(r"[\u0000-\u001f\u007f]", "", title)[:200]


def duration_string(seconds) -> Optional[str]:
    if not seconds:
        return None
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"