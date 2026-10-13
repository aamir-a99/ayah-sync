#!/usr/bin/env bash
# Start the Ayah Sync helper (macOS/Linux). First run sets everything up.
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "FFmpeg was not found. Install it (brew install ffmpeg / apt install ffmpeg) and run this again."; exit 1; }
if [ ! -x ".venv/bin/python" ]; then
  echo "Setting up for the first time. This can take several minutes..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  if command -v nvidia-smi >/dev/null; then
    .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu124
  fi
  .venv/bin/pip install -r requirements.txt
fi
echo "Starting the helper. Leave this window open while you use the extension."
.venv/bin/python server.py
