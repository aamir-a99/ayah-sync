"""
End-to-end test for the recognition server.

Downloads real recitation audio, decodes it to 16 kHz mono Float32 with ffmpeg,
streams it to the running server over the WebSocket exactly like the extension
would, and prints the matched verses. Confirms the whole pipeline works.

Usage: start the server (python server.py) in one terminal, then run:
       python test_client.py
"""
import asyncio
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import websockets

URL = "ws://127.0.0.1:8790"
SR = 16000

# A sequence of consecutive ayahs to simulate continuous recitation.
CLIPS = [
    ("2:255", "002255"),
    ("112:1", "112001"),
    ("1:1", "001001"),
    ("1:2", "001002"),
]


def fetch_pcm(everyayah_id: str) -> np.ndarray:
    mp3 = Path(tempfile.gettempdir()) / f"qlt_{everyayah_id}.mp3"
    if not mp3.exists():
        urllib.request.urlretrieve(
            f"https://everyayah.com/data/Alafasy_128kbps/{everyayah_id}.mp3", mp3
        )
    raw = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", str(mp3), "-ar", str(SR), "-ac", "1", "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


async def main():
    print("Decoding test clips…")
    clips = [(ref, fetch_pcm(fid)) for ref, fid in CLIPS]

    async with websockets.connect(URL, max_size=None) as ws:
        got = []

        async def reader():
            async for msg in ws:
                data = json.loads(msg)
                if data.get("type") == "result":
                    m = data["match"]
                    print(f"  <- {m['ref']}  w{m['word']}/{m['wordCount']}  "
                          f"score {m['score']:.2f}  {m['surahMeta']['englishName']}")
                    got.append(m["ref"])
                elif data.get("type") == "ready":
                    print("  server ready")

        rtask = asyncio.create_task(reader())

        # Stream each clip in ~0.25s frames at real-time pace, then pause so the
        # server's interval-based pass runs.
        frame = SR // 4
        for ref, pcm in clips:
            print(f"streaming {ref} ({len(pcm)/SR:.1f}s)…")
            for i in range(0, len(pcm), frame):
                await ws.send(pcm[i:i + frame].tobytes())
                await asyncio.sleep(0.25)
            await asyncio.sleep(3.0)  # let the server transcribe

        await asyncio.sleep(1.0)
        rtask.cancel()
        print(f"\nMatched refs (in order): {got}")


if __name__ == "__main__":
    asyncio.run(main())
