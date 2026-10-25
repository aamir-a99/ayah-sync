"""Bounded PCM windows for browser CPU look-ahead; no speech model is loaded."""
import asyncio
import base64
import json
import math
import subprocess
import threading
from contextlib import suppress
from urllib.parse import urlsplit

import align

SR = 16000
MAX_WINDOW = 24


class DownloadCancelled(Exception):
    pass


def prepare(url, media=None, report=None, cancelled=None):
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("Open an HTTP(S) video page first.")
    try:
        _, info, path = align.fetch_audio(url, report)
    except DownloadCancelled:
        raise
    except Exception:
        if cancelled is not None and cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        if not media or urlsplit(media).scheme not in ("http", "https"):
            raise
        _, info, path = align.fetch_direct(url, media, report)
    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, check=True, timeout=30,
    ).stdout)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("This video has no finite audio duration. Use CPU live listening for streams.")
    return {"path": path, "duration": duration, "title": info.get("title", "")}


def read_window(source, start, seconds):
    start, seconds = float(start), float(seconds)
    if not math.isfinite(start) or not math.isfinite(seconds) or start < 0 or not 0 < seconds <= MAX_WINDOW:
        raise ValueError("Invalid audio window (maximum 24 seconds).")
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-threads", "1", "-ss", str(start), "-i", str(source["path"]),
         "-t", str(seconds), "-ar", str(SR), "-ac", "1", "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=30,
    ).stdout
    if len(raw) > math.ceil(seconds * SR) * 4 + 4096:
        raise ValueError("Audio window exceeded its limit.")
    return base64.b64encode(raw).decode("ascii")


async def prepare_message(ws, data):
    # Progress is coalesced; yt-dlp may call its hook far faster than the UI.
    progress = {"pct": 0.0}
    cancelled = threading.Event()
    def report(value):
        if cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        progress["pct"] = float(value)
    async def watch_close():
        await ws.wait_closed()
        cancelled.set()
    async def heartbeat():
        while True:
            await ws.send(json.dumps({"type": "cpu_audio_progress", **progress}))
            await asyncio.sleep(1)
    task = asyncio.create_task(heartbeat())
    closed = asyncio.create_task(watch_close())
    try:
        source = await asyncio.to_thread(prepare, data.get("url", ""), data.get("media"), report, cancelled)
        if cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        await ws.send(json.dumps({"type": "cpu_audio_ready", "duration": source["duration"],
                                  "title": source["title"], "sampleRate": SR}))
        return source
    finally:
        task.cancel()
        closed.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task
        with suppress(asyncio.CancelledError, Exception):
            await closed


async def window_message(ws, source, data):
    if source is None:
        raise ValueError("Prepare the video audio first.")
    pcm = await asyncio.to_thread(read_window, source, data.get("start", 0), data.get("seconds", 16))
    await ws.send(json.dumps({"type": "cpu_audio_window", "id": data.get("id"),
                              "start": data.get("start", 0), "pcm": pcm, "sampleRate": SR}))
