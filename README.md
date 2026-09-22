# VidFetch

A clean, self-hosted video & audio downloader web app powered by
[**yt-dlp**](https://github.com/yt-dlp/yt-dlp) and
[**FFmpeg**](https://ffmpeg.org). Zero third-party Python dependencies —
it runs on the standard library.

## Features

- 🎬 **Video downloads** — MP4 up to 4K (best merge of video + audio streams)
- 🎵 **Audio extraction** — MP3 (192 kbps), M4A, OPUS, FLAC
- 📋 **Metadata fetch** — thumbnail, title, duration, uploader before you download
- 📊 **Live progress** — animated bar, speed, ETA, merge/conversion stage
- 🗂️ **Downloads library** — every finished file stays listed with save & delete
- ✂️ **Cancel support** — abort a running or queued download cleanly
- 🛡️ **Local-first** — everything runs on your machine; no accounts, no ads
- 🖥️ **Modern dark UI** — no CDNs, no frameworks, pure HTML/CSS/JS

## Requirements

- Python 3.9+
- `yt-dlp` (`apt install yt-dlp` or `pip install yt-dlp`)
- `ffmpeg` with `ffprobe` (`apt install ffmpeg`)

## Quick start

```bash
python3 server.py
# or
./run.sh
```

Then open **http://localhost:8000**, paste a link, choose a format, done.

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `VIDFETCH_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on your LAN. |
| `VIDFETCH_PORT` | `8000` | Port to listen on. |
| `VIDFETCH_MAX_CONCURRENT` | `2` | Maximum simultaneous downloads. |
| `VIDFETCH_BLOCK_PRIVATE_IPS` | `1` | SSRF guard: refuse hosts that only resolve to private/local addresses. Set `0` to disable. |
| `VIDFETCH_FFMPEG` | (auto) | Explicit path to the `ffmpeg` binary if not on PATH. |

CLI flags `--host`, `--port` and `--debug` override `VIDFETCH_HOST`/`VIDFETCH_PORT`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/info?url=…` | Video metadata (no download) |
| `POST` | `/api/download` | Body `{url, kind: video\|audio, quality}` — starts a job |
| `GET` | `/api/jobs` | All jobs (poll this for progress) |
| `GET` | `/api/jobs/<id>` | Single job |
| `POST` | `/api/jobs/<id>/cancel` | Cancel a running job |
| `DELETE` | `/api/jobs/<id>` | Remove job + delete its files |
| `GET` | `/api/file/<jobid>/<index>` | Stream a finished file |

## How downloads work

1. You paste a URL; the server extracts metadata with yt-dlp (`extract_flat`).
2. Starting a format queues a job (concurrency-limited background thread).
3. yt-dlp picks the best stream ≤ your chosen quality, and **FFmpeg merges
   video+audio into MP4** (`merge_output_format=mp4`) or converts audio to the
   requested codec (`FFmpegExtractAudio`).
4. Cover art and metadata are embedded into the final file.
5. The frontend polls `/api/jobs` every ~1.2s for live progress.

## Security notes

- **SSRF guard** (default on): the URL's hostname is resolved and refused if it
  only maps to private/loopback/link-local addresses. CDN-style mixed address
  sets are allowed to avoid false positives.
- Only `http`/`https` URLs are accepted.
- Downloads are confined to per-job directories inside `downloads/`, and file
  requests are served by index with a real-path containment check (no path
  traversal).
- Playlist URLs are **not** followed (`noplaylist`) — one video per request.
- Binding defaults to `127.0.0.1` so the app is only reachable from your own
  machine. Don't expose it to the open internet without auth.

## Caveats

- **YouTube** may emit a warning about a missing JavaScript runtime
  (e.g. Deno). Many videos still download fine; install
  [Deno](https://deno.com/) (or set `--js-runtimes`) to get the complete set of
  formats.
- Downloading may fail for DRM-protected or age-restricted content — that is
  outside the scope of any tool.
- **Please only download content you own or have rights to.**

## Layout

```
server.py        HTTP server + JSON API (stdlib only)
downloader.py    download engine around the yt-dlp Python API
static/          frontend (index.html, style.css, app.js, favicon.svg)
downloads/       finished files + job metadata (created at runtime)
```