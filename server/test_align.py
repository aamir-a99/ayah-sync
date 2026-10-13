"""
Ground-truth check for the whole-video aligner.

quran.com publishes hand-verified word timings ("segments") for its own
recitations. We run OUR pipeline blind on the same audio file and measure how
far each word's start time lands from quran.com's.

Usage:  python test_align.py [chapter] [recitation_id]     (default 67, 7 = Alafasy)
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from quran_matcher import QuranMatcher, normalize_arabic
import align

chapter = int(sys.argv[1]) if len(sys.argv) > 1 else 67
recitation = int(sys.argv[2]) if len(sys.argv) > 2 else 7

UA = {"User-Agent": "Mozilla/5.0"}
meta = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"https://api.quran.com/api/v4/chapter_recitations/{recitation}/{chapter}?segments=true", headers=UA)).read())["audio_file"]
align.CACHE_DIR.mkdir(exist_ok=True)
mp3 = align.CACHE_DIR / f"gt_{recitation}_{chapter}.mp3"
if not mp3.exists():
    mp3.write_bytes(urllib.request.urlopen(urllib.request.Request(meta["audio_url"], headers=UA)).read())

matcher = QuranMatcher(Path(__file__).resolve().parent.parent / "src" / "data")

import torch
from transformers import pipeline
MODEL = os.environ.get("QLT_MODEL", "openai/whisper-large-v3")
gpu = torch.cuda.is_available()
asr = pipeline("automatic-speech-recognition", model=MODEL, device=0 if gpu else -1,
               torch_dtype=torch.float16 if gpu else torch.float32)

audio = align.load_audio(mp3)
t = time.time()
from ctc_align import CtcAligner
ctc = None if os.environ.get("QLT_NO_CTC") else CtcAligner()
words = align.transcribe_chunks(asr, audio, MODEL.startswith("openai/"))
t_asr = time.time() - t
t = time.time()
tl = align.build_timeline(matcher, words, audio, ctc)
t_al = time.time() - t
print(f"audio {len(audio)/align.SR:.0f}s | transcribe {t_asr:.1f}s | align {t_al:.2f}s | "
      f"{tl["heardWords"]} heard words | {len(tl['ayahs'])} ayahs | passages {tl['passages']}")

# quran.com counts real words only; our display words also include pause marks.
ours = {}
for e in tl["ayahs"]:
    disp = [w for w in re.split(r"\s+", e["arabic"].strip()) if w]
    real = [e["w"][i] for i, w in enumerate(disp) if normalize_arabic(w)]
    ours.setdefault(e["ref"], real)

errs, missing, total, mism = [], 0, 0, 0
for v in meta["timestamps"]:
    segs = [s for s in v["segments"] if len(s) == 3]
    got = ours.get(v["verse_key"])
    total += len(segs)
    if got is None:
        missing += len(segs)
        continue
    if len(got) != len(segs):
        mism += 1
    for wi, s_ms, _ in segs:
        if 1 <= wi <= len(got):
            errs.append(abs(got[wi - 1] - s_ms / 1000))
errs = np.array(errs)
print(f"words compared {len(errs)}/{total} (missing {missing}, ayahs with word-count mismatch {mism})")
print(f"start-time error: median {np.median(errs)*1000:.0f} ms | mean {errs.mean()*1000:.0f} ms | "
      f"p90 {np.percentile(errs,90)*1000:.0f} ms | p99 {np.percentile(errs,99)*1000:.0f} ms | max {errs.max()*1000:.0f} ms")
for thr in (0.2, 0.35, 0.5, 1.0):
    print(f"  within {int(thr*1000)} ms: {(errs <= thr).mean()*100:.1f}%")
exp_refs = [v["verse_key"] for v in meta["timestamps"]]
got_refs = [e["ref"] for e in tl["ayahs"]]
print("ayah sequence exact:", got_refs == exp_refs, "| extra:", [r for r in got_refs if r not in exp_refs][:8])
json.dump(tl, open(align.CACHE_DIR / f"gt_{recitation}_{chapter}.timeline.json", "w", encoding="utf-8"), ensure_ascii=False)
