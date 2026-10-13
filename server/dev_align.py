"""
Developer loop for the aligner on an already-downloaded audio file.

Transcription is the slow part, so its output is kept beside the audio; rerun
after changing the alignment code and only the alignment is redone.

Usage:  python dev_align.py <cache key, e.g. Youtube__RPZzKZsOSU> [--retranscribe]
"""
import json
import sys
import time

import engine
import align


def clock(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


key = sys.argv[1]
audio_path = next(p for p in align.CACHE_DIR.glob(key + ".*") if p.suffix not in (".json", ".part"))
audio = align.load_audio(audio_path)
chunk_file = align.CACHE_DIR / f"{key}.chunks.json"

engine.matcher = engine.QuranMatcher(engine.DATA_DIR)
if chunk_file.exists() and "--retranscribe" not in sys.argv:
    chunks = json.loads(chunk_file.read_text("utf-8"))
else:
    engine.load()
    t = time.time()
    chunks = align.transcribe_chunks(engine.asr, audio, engine.MULTILINGUAL)
    print(f"transcribed {len(audio)/align.SR:.0f}s of audio in {time.time()-t:.1f}s")
    chunk_file.write_text(json.dumps(chunks, ensure_ascii=False), "utf-8")

t = time.time()
tl = align.build_timeline(engine.matcher, chunks, audio, engine.ctc())
print(f"aligned in {time.time()-t:.1f}s — {len(tl['ayahs'])} ayahs")
for p in tl["passages"]:
    print(f"  passage {p['from']} → {p['to']}  ({p['ayahs']} ayahs)  {clock(p['t0'])}–{clock(p['t1'])}")
if "--words" in sys.argv:
    for e in tl["ayahs"]:
        print(f"{clock(e['t0'])}–{clock(e['t1'])} {e['ref']}: " + " ".join(f"{w:.1f}" for w in e["w"]))
else:
    for e in tl["ayahs"]:
        print(f"  {clock(e['t0']):>9} → {clock(e['t1']):>9}  {'basmala' if e.get('basmala') else e['ref']:>8}  {e['arabic'][:44]}")
if "--chunks" in sys.argv:
    for c in chunks:
        print(f"[{clock(c['s']/align.SR)}–{clock(c['e']/align.SR)}] {c['text']}")
