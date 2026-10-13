# Quran Live — helper

The extension can show a card and read a video's clock; the listening happens
here. This is a small WebSocket server (`ws://127.0.0.1:8790`) with two jobs:

- **Sync a video** — download its audio once, work out which ayahs are recited,
  time every word, and hand back a timeline. Results are cached per video.
- **Listen live** — for live streams: receive the tab's audio, and report the
  current ayah every few seconds.

## Run

Windows: double-click `run.bat`. macOS / Linux: `./run.sh`.

The first run creates a Python environment in `.venv`, installs the
requirements (the GPU build of torch when an NVIDIA card is found) and
downloads the models:

| Model | Used for | Size |
|---|---|---|
| `openai/whisper-large-v3` | transcription | ~3 GB |
| `jonatasgrosman/wav2vec2-large-xlsr-53-arabic` | word timing | ~1.2 GB |

It is ready when it prints `Listening on ws://127.0.0.1:8790`.

No NVIDIA card? Set `QLT_MODEL=tarteel-ai/whisper-base-ar-quran` before
starting. It is quick on a processor but only reliable on clean studio
recitation.

## Files

| File | What it does |
|---|---|
| `server.py` | WebSocket server: sync requests and the live loop |
| `align.py` | Whole-video pipeline: download, transcribe, locate passages, time words |
| `ctc_align.py` | Forced alignment (wav2vec2 emissions + Viterbi) |
| `quran_matcher.py` | Finds recited text in the Quran, tolerant of recognition errors |
| `engine.py` | Loads the models once for the server and the tools |
| `cache/` | Downloaded audio and saved timelines (safe to delete) |

## Tools

With the helper running:

```bash
.venv/Scripts/python test_sync.py "https://www.youtube.com/watch?v=..."   # sync a video and print the result
```

Without it (these load the models themselves):

```bash
.venv/Scripts/python test_align.py 67 7      # accuracy vs quran.com's word timings (surah, reciter id)
.venv/Scripts/python inspect_align.py 67 7   # list the words that were furthest off
.venv/Scripts/python dev_align.py <cache key> # re-run alignment on downloaded audio
```

## Protocol

Client → server

- `{"type": "align", "url": "...", "media": "...", "force": false}` — sync a
  video. `media` is the page's own link to the video file, used if the page
  address can't be downloaded.
- binary frames of 16 kHz mono Float32 PCM — live audio.
- `{"type": "ping"}`

Server → client

- `{"type": "ready", "model": "...", "device": "cuda"}`
- `{"type": "align_progress", "stage": "download|transcribe|align", "pct": 0.4}`
- `{"type": "align_result", "timeline": {...}}` or `{"type": "align_error", "error": "..."}`
- `{"type": "result", "match": {...}}` — live mode.

A timeline is `{ayahs: [{ref, surah, ayah, t0, t1, w: [word start times], arabic,
arabicIndopak, translation, surahMeta}], passages, duration, title}`.
