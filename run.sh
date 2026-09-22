#!/usr/bin/env bash
# VidFetch launcher
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py "$@"