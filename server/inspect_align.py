"""Show where a saved timeline disagrees with quran.com's segments (debug aid).
Usage: python inspect_align.py [chapter] [recitation_id]"""
import json
import re
import sys
import urllib.request

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from quran_matcher import normalize_arabic
import align

chapter = int(sys.argv[1]) if len(sys.argv) > 1 else 67
recitation = int(sys.argv[2]) if len(sys.argv) > 2 else 7
meta = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"https://api.quran.com/api/v4/chapter_recitations/{recitation}/{chapter}?segments=true",
    headers={"User-Agent": "Mozilla/5.0"})).read())["audio_file"]
tl = json.load(open(align.CACHE_DIR / f"gt_{recitation}_{chapter}.timeline.json", encoding="utf-8"))

ours = {}
for e in tl["ayahs"]:
    disp = [w for w in re.split(r"\s+", e["arabic"].strip()) if w]
    ours.setdefault(e["ref"], [(e["w"][i], w) for i, w in enumerate(disp) if normalize_arabic(w)])

signed, rows = [], []
for v in meta["timestamps"]:
    segs = [s for s in v["segments"] if len(s) == 3]
    got = ours.get(v["verse_key"], [])
    if len(got) != len(segs):
        print(f"count mismatch {v['verse_key']}: ours {len(got)} vs quran.com {len(segs)} "
              f"(their indices {[s[0] for s in segs]})")
    for wi, s_ms, e_ms in segs:
        if 1 <= wi <= len(got):
            d = got[wi - 1][0] - s_ms / 1000
            signed.append(d)
            rows.append((abs(d), v["verse_key"], wi, got[wi - 1][1], got[wi - 1][0], s_ms / 1000))
signed = np.array(signed)
print(f"signed error: median {np.median(signed)*1000:+.0f} ms, mean {signed.mean()*1000:+.0f} ms")
for r in sorted(rows, reverse=True)[:25]:
    print(f"  {r[0]*1000:7.0f} ms  {r[1]} w{r[2]} {r[3]}  ours {r[4]:.2f}  theirs {r[5]:.2f}")
