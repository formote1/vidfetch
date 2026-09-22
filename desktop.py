#!/usr/bin/env python3
"""VidFetch desktop app — a native desktop window over the local downloader.

The existing stdlib HTTP server runs on a background thread (default port
8200 so it never clashes with the browser version on 8000) and a native
window points at its dedicated /desktop UI, which is designed to look like
a desktop app rather than the website.

Requires:
    pip install pywebview
plus the platform webview runtime:
    Linux   : GTK3 + WebKit2  (python3-gi, gir1.2-webkit2-4.1 …)
    macOS   : built-in WebKit
    Windows : WebView2 runtime
"""
from __future__ import annotations

import argparse
import logging
import os
import threading

import server as srv


def main():
    ap = argparse.ArgumentParser(description="VidFetch desktop app")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("VIDFETCH_DESKTOP_PORT", "8200")))
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    # local backend server on a background thread
    httpd = srv.make_server("127.0.0.1", args.port)
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="vidfetch-http").start()

    try:
        import webview  # deferred: only needed at launch
    except ImportError:
        httpd.shutdown()
        httpd.server_close()
        raise SystemExit(
            "pywebview is required for the desktop app.\n"
            "  pip install pywebview\n"
            "On Linux you may also need: "
            "apt install python3-gi gir1.2-webkit2-4.1\n"
            "(or use the browser version: python3 server.py)")

    try:
        webview.create_window(
            "VidFetch",
            f"http://127.0.0.1:{args.port}/desktop",
            width=1180,
            height=780,
            min_size=(880, 620),
            background_color="#000000",
        )
        webview.start()
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()