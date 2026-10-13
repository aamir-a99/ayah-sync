"""Model loading shared by the server and the command-line tools."""
import os
import sys
import threading
from pathlib import Path

for _s in (sys.stdout, sys.stderr):          # Windows consoles can't print Arabic by default
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from quran_matcher import QuranMatcher

# A large general model on GPU copes with noisy, reverberant recordings; the
# matcher absorbs its small wording errors. Override with QLT_MODEL.
MODEL_ID = os.environ.get("QLT_MODEL", "openai/whisper-large-v3")
# General Whisper models need Arabic forced; Quran fine-tunes must NOT be given
# language/task (their config is single-language-flagged and would raise).
MULTILINGUAL = MODEL_ID.startswith("openai/")
DATA_DIR = Path(__file__).resolve().parent.parent / "src" / "data"

matcher = None
asr = None
device = "cpu"
_ctc = None
_ctc_lock = threading.Lock()
gpu_lock = threading.Lock()                  # one model on the GPU at a time


def load():
    global matcher, asr, device
    print("Loading Quran index…")
    matcher = QuranMatcher(DATA_DIR)
    print(f"  {len(matcher.tokens)} tokens, {len(matcher.trigrams)} trigrams")
    print(f"Loading speech model {MODEL_ID} … (first run downloads it)")
    import torch
    from transformers import pipeline

    gpu = torch.cuda.is_available()
    device = "cuda" if gpu else "cpu"
    asr = pipeline("automatic-speech-recognition", model=MODEL_ID, device=0 if gpu else -1,
                   torch_dtype=torch.float16 if gpu else torch.float32)
    print(f"  ready on {device}")


def ctc():
    """The forced-alignment model, loaded the first time a video is synced."""
    global _ctc
    with _ctc_lock:
        if _ctc is None:
            from ctc_align import CtcAligner
            print("Loading alignment model … (first run downloads it, ~1.2 GB)")
            _ctc = CtcAligner()
            print("  alignment model ready")
        return _ctc
