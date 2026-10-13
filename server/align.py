"""
Whole-video alignment ("sync once, follow exactly").

Instead of guessing the position live, we take the complete audio of an
on-demand video and build a word-level timestamp table for it, the way
quran.com does for its own recitations:

  1. audio  -> cut into <=28 s pieces at the quietest points (breaths)
  2. pieces -> Whisper with word-level timestamps
  3. words  -> located in the Quran (trigram offset voting over sliding windows)
  4. words  -> aligned token-by-token to the canonical text (fuzzy
               Needleman-Wunsch), so every Quran word gets a start time, with
               interpolation for the words the recogniser fumbled
  5. result -> a timeline of ayahs with per-word start times

The extension then just reads video.currentTime and looks the word up.
"""
import json
import re
import subprocess
from pathlib import Path

import numpy as np

from quran_matcher import normalize_arabic

SR = 16000
FRAME = 320                 # 20 ms analysis frame
MAX_CHUNK_S = 28.0          # Whisper sees 30 s; stay under it
MIN_CHUNK_S = 12.0
SILENT_RMS = 0.004

WIN = 12                    # sliding window (tokens) for locating the passage
WIN_STEP = 4
OFFSET_TOL = 10             # extra words heard (offset shrinks) tolerated inside one passage
SKIP_TOL = 60               # words the recogniser may drop (offset grows) inside one passage
BLOCK = 100                 # tokens per alignment block
MARGIN = 15                 # extra canonical tokens considered either side of a block
EDGE_FILL = 5               # complete an ayah if at most this many edge words went unheard

CACHE_DIR = Path(__file__).resolve().parent / "cache"


# --------------------------------------------------------------------------- audio
def load_audio(path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ar", str(SR), "-ac", "1", "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def split_at_silence(audio: np.ndarray):
    """Sample ranges of at most MAX_CHUNK_S, cut where the recitation is quietest."""
    n = len(audio) // FRAME
    if n == 0:
        return []
    frames = audio[: n * FRAME].reshape(n, FRAME)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    smooth = np.convolve(rms, np.ones(10) / 10, mode="same")
    per_s = SR / FRAME
    lo_f, hi_f = int(MIN_CHUNK_S * per_s), int(MAX_CHUNK_S * per_s)
    cuts, pos = [0], 0
    while n - pos > hi_f:
        j = pos + lo_f + int(np.argmin(smooth[pos + lo_f: pos + hi_f]))
        cuts.append(j)
        pos = j
    cuts.append(n)
    return [(cuts[i] * FRAME, cuts[i + 1] * FRAME) for i in range(len(cuts) - 1)]


# ------------------------------------------------------------------- transcription
def transcribe_chunks(asr, audio: np.ndarray, multilingual=True, batch_size=4, progress=None):
    """-> [{"s": sample_start, "e": sample_end, "text": str}] covering the audio."""
    ranges = split_at_silence(audio)
    gk = {"num_beams": 1}
    if multilingual:
        gk.update(language="arabic", task="transcribe")
    chunks = []
    for b in range(0, len(ranges), batch_size):
        batch = ranges[b: b + batch_size]
        inputs, keep = [], []
        for (s, e) in batch:
            seg = audio[s:e].astype(np.float32, copy=True)
            if len(seg) < SR * 0.4 or float(np.sqrt((seg ** 2).mean())) < SILENT_RMS:
                chunks.append({"s": s, "e": e, "text": ""})
                continue
            peak = float(np.max(np.abs(seg))) or 1.0
            inputs.append({"raw": seg / peak, "sampling_rate": SR})
            keep.append((s, e))
        if inputs:
            outs = asr(inputs, batch_size=len(inputs), generate_kwargs=gk)
            for (s, e), out in zip(keep, outs):
                chunks.append({"s": s, "e": e, "text": (out.get("text") or "").strip()})
        if progress:
            progress(min(1.0, (b + len(batch)) / max(1, len(ranges))))
    chunks.sort(key=lambda c: c["s"])
    return chunks


# ----------------------------------------------------------------------- alignment
def _lev(a: str, b: str, cap: int = 2) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _sim(a: str, b: str) -> float:
    if a == b:
        return 1.0
    m = min(len(a), len(b))
    if m >= 3 and _lev(a, b, 1) <= 1:
        return 0.6
    if m >= 5 and _lev(a, b, 2) <= 2:
        return 0.45
    return -0.6


def _nw(heard, canon):
    """Fuzzy global alignment of heard tokens against a canonical slice whose
    leading/trailing tokens are free to skip. -> [(heard_i, canon_j, strong)]"""
    n, m = len(heard), len(canon)
    GAP = -0.4
    score = np.zeros((n + 1, m + 1), dtype=np.float32)
    back = np.zeros((n + 1, m + 1), dtype=np.int8)   # 1 diag, 2 up (skip heard), 3 left (skip canon)
    for i in range(1, n + 1):
        score[i, 0] = i * GAP
        back[i, 0] = 2
    for j in range(1, m + 1):
        back[0, j] = 3                                # free leading canon skip
    sims = [[_sim(h, c) for c in canon] for h in heard]
    for i in range(1, n + 1):
        row, prow, srow = score[i], score[i - 1], sims[i - 1]
        for j in range(1, m + 1):
            d = prow[j - 1] + srow[j - 1]
            u = prow[j] + GAP
            l = row[j - 1] + GAP
            if d >= u and d >= l:
                row[j], back[i, j] = d, 1
            elif u >= l:
                row[j], back[i, j] = u, 2
            else:
                row[j], back[i, j] = l, 3
    j = int(np.argmax(score[n]))                      # free trailing canon skip
    i, pairs = n, []
    while i > 0 and j > 0:
        b = back[i, j]
        if b == 1:
            s = sims[i - 1][j - 1]
            pairs.append((i - 1, j - 1, s))
            i, j = i - 1, j - 1
        elif b == 2:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def _same_passage(prev_off: int, off: int) -> bool:
    """Does `off` continue the passage that was at `prev_off`?

    The offset grows when the recogniser drops words (tolerated generously) and
    shrinks when extra words were heard. A big drop means the reciter went BACK
    and is repeating — that is a new passage, and the card should replay it."""
    return -OFFSET_TOL <= off - prev_off <= SKIP_TOL


def _locate(matcher, toks):
    """Sliding-window trigram voting -> [(window_start, offset, votes)] where
    canonical_pos ~= token_index + offset."""
    found = []
    for i in range(0, max(1, len(toks) - 2), WIN_STEP):
        votes = {}
        for k in range(i, min(i + WIN, len(toks)) - 2):
            for p in matcher.trigrams.get(f"{toks[k]} {toks[k+1]} {toks[k+2]}", ()):
                votes[p - k] = votes.get(p - k, 0) + 1
        if not votes:
            continue
        ranked = sorted(votes.items(), key=lambda kv: -kv[1])
        off, v = ranked[0]
        runner = ranked[1][1] if len(ranked) > 1 else 0
        # Refrains and look-alike verses (55's refrain, 18:45 vs 10:24) score
        # the same in several places: prefer the place we already are.
        recent = [f[1] for f in found[-2:]]
        stay = [(o, n) for o, n in ranked[:6]
                if n >= max(2, v - 1) and any(_same_passage(r, o) for r in recent)]
        if stay:
            off, v = min(stay, key=lambda c: min(abs(c[0] - r) for r in recent))
            found.append((i, off, v))
        elif v >= 3 or (v >= 2 and runner < v):
            found.append((i, off, v))
    # Drop lone windows nobody nearby agrees with (a common phrase matched elsewhere).
    kept = []
    for idx, (i, off, v) in enumerate(found):
        near = [found[j] for j in (idx - 1, idx + 1) if 0 <= j < len(found)]
        if v >= 6 or any((_same_passage(o, off) or _same_passage(off, o)) and abs(i2 - i) <= WIN_STEP * 4
                         for i2, o, _ in near):
            kept.append((i, off, v))
    return kept


def _passages(located):
    """Group consecutive windows that continue one another into passages."""
    out = []
    for i, off, _ in located:
        if out and _same_passage(out[-1][-1][1], off):
            out[-1].append((i, off))
        else:
            out.append([(i, off)])
    return out


def _refine(matcher, ctc, audio, chunks, tchunk, pairs, pmin, pmax, start, ends, t_min=0.0, progress=None):
    """Replace the coarse per-chunk times with CTC forced-alignment times.

    The passage is cut into sections at chunk boundaries (chunks end in
    silence, so no word straddles one) and each section's canonical words are
    force-aligned to that section's audio."""
    from ctc_align import viterbi, FRAME_S

    first_pos, last_pos = {}, {}
    for pos, h, _ in pairs:
        c = tchunk[h]
        first_pos.setdefault(c, pos)
        last_pos[c] = pos
    c_first, c_last = min(first_pos), max(last_pos)

    sections, sec_c, sec_p = [], c_first, pmin
    for c in range(c_first, c_last):
        if c not in last_pos or (c + 1) not in first_pos:
            continue
        dur = (chunks[c]["e"] - chunks[sec_c]["s"]) / SR
        clean = first_pos[c + 1] == last_pos[c] + 1
        if (dur >= 45 and clean) or dur >= 150:
            sections.append((sec_c, c, sec_p, first_pos[c + 1] - 1))
            sec_c, sec_p = c + 1, first_pos[c + 1]
    sections.append((sec_c, c_last, sec_p, pmax))

    words_of = {}

    def display_word(pos):
        ref = matcher.pos_to_ref[pos]
        if ref not in words_of:
            words_of[ref] = [w for w in re.split(r"\s+", matcher.arabic[ref].strip()) if w]
        return ref, matcher.pos_to_word[pos]

    for si, (c0, c1, p0, p1) in enumerate(sections):
        if p1 < p0:
            continue
        ems, times = [], []
        for c in range(c0, c1 + 1):
            s0 = max(chunks[c]["s"], int(t_min * SR))   # audio before t_min belongs to the previous passage
            seg = audio[s0: chunks[c]["e"]]
            if len(seg) < 800:
                continue
            em = ctc.emissions(seg)
            ems.append(em)
            times.append(s0 / SR + np.arange(len(em)) * FRAME_S)
        if not ems:
            continue
        em, times = np.concatenate(ems), np.concatenate(times)

        ids, owner, seen = [], [], set()
        for p in range(p0, p1 + 1):
            key = display_word(p)
            if key in seen:                       # a display word that split into two tokens
                continue
            seen.add(key)
            enc = ctc.encode(words_of[key[0]][key[1]])
            if not enc:
                continue
            if ids and ctc.delim is not None:
                ids.append(ctc.delim)
                owner.append(None)
            ids += enc
            owner += [p] * len(enc)
        res = viterbi(em, ids, ctc.blank, star_start=(si == 0), star_end=(si == len(sections) - 1))
        if res is None:
            continue
        for (f0, f1), p in zip(res, owner):
            if p is None:
                continue
            t0, t1 = float(times[f0]), float(times[f1]) + FRAME_S
            if p not in ends:                     # first letter of the word
                start[p] = t0
            ends[p] = t1
        if progress:
            progress((si + 1) / len(sections))


def build_timeline(matcher, chunks, audio=None, ctc=None, progress=None):
    """chunks: [{"s","e","text"}] -> timeline dict. With `ctc` + `audio` the word
    times are forced-aligned; without, they are a coarse per-chunk estimate."""
    toks, tchunk, t0s, t1s = [], [], [], []
    for ci, ch in enumerate(chunks):
        ct = normalize_arabic(ch["text"]).split()
        cs, ce = ch["s"] / SR, ch["e"] / SR
        for k, t in enumerate(ct):
            toks.append(t)
            tchunk.append(ci)
            t0s.append(cs + (ce - cs) * k / len(ct))
            t1s.append(cs + (ce - cs) * (k + 1) / len(ct))

    passages = _passages(_locate(matcher, toks))
    ntok = len(matcher.tokens)
    entries, summary = [], []
    heard_floor = 0                # heard tokens already claimed by an earlier passage
    time_floor = 0.0               # audio already claimed by an earlier passage

    for pi, wins in enumerate(passages):
        a = max(heard_floor, wins[0][0] - WIN)
        b = min(len(toks), wins[-1][0] + WIN + WIN)
        if pi + 1 < len(passages):
            b = min(b, passages[pi + 1][0][0] + WIN_STEP)
        if b - a < 3:
            continue

        def off_at(i):
            return min(wins, key=lambda w: abs(w[0] - i))[1]

        # -- token-level alignment, block by block, kept monotone by `floor`
        pairs, floor = [], -1
        for s in range(a, b, BLOCK):
            e = min(b, s + BLOCK)
            c0 = max(floor + 1, s + off_at(s) - MARGIN, 0)
            c1 = min(ntok, e + off_at(e) + MARGIN)
            if c1 - c0 < 2:
                continue
            for hi, cj, sim in _nw(toks[s:e], matcher.tokens[c0:c1]):
                pos = c0 + cj
                if pos > floor:
                    pairs.append((pos, s + hi, sim))
                    floor = pos

        exact = [p for p in pairs if p[2] >= 1.0]
        if len(exact) < 3:
            continue
        # A passage begins and ends on words that were heard exactly; looser
        # pairs hanging off either end usually belong to something else.
        first, last = exact[0][0], exact[-1][0]
        pairs = [p for p in pairs if first <= p[0] <= last]
        heard_floor = pairs[-1][1] + 1

        # -- coarse start time for every canonical token in [pmin, pmax]
        pmin, pmax = pairs[0][0], pairs[-1][0]
        start = {p: t0s[h] for p, h, _ in pairs}
        end_of_last = t1s[pairs[-1][1]]
        known = sorted(start)
        for k in range(len(known) - 1):
            p1, p2 = known[k], known[k + 1]
            for p in range(p1 + 1, p2):
                start[p] = start[p1] + (start[p2] - start[p1]) * (p - p1) / (p2 - p1)
        span = max(0.2, (end_of_last - start[pmin]) / max(1, pmax - pmin + 1))

        # -- complete an ayah whose first/last few words went unheard
        lo, hi = pmin, pmax
        while lo > 0 and matcher.pos_to_ref[lo - 1] == matcher.pos_to_ref[pmin]:
            lo -= 1
        while hi + 1 < ntok and matcher.pos_to_ref[hi + 1] == matcher.pos_to_ref[pmax]:
            hi += 1
        if pmin - lo <= EDGE_FILL:
            for p in range(pmin - 1, lo - 1, -1):
                start[p] = max(0.0, start[p + 1] - span)
            pmin = lo
        if hi - pmax <= EDGE_FILL:
            for p in range(pmax + 1, hi + 1):
                start[p] = start[p - 1] + span
            end_of_last += span * (hi - pmax)
            pmax = hi

        # -- a very short ayah just before the passage (يسٓ, الٓمٓ, طه …) can't be
        #    located by itself; offer it to the aligner, which drops it if absent
        if pmin > 0 and matcher.pos_to_ref[pmin - 1].split(":")[0] == matcher.pos_to_ref[pmin].split(":")[0]:
            q = pmin - 1
            while q > 0 and matcher.pos_to_ref[q - 1] == matcher.pos_to_ref[pmin - 1]:
                q -= 1
            if pmin - q <= 3 and matcher.pos_to_ref[q] != matcher.pos_to_ref[pmin]:
                for p in range(pmin - 1, q - 1, -1):
                    start[p] = max(time_floor, start[p + 1] - span)
                pmin = q

        # -- precise times from forced alignment
        ends = {}
        if ctc is not None and audio is not None:
            _refine(matcher, ctc, audio, chunks, tchunk, pairs, pmin, pmax, start, ends, time_floor, progress)
            if pmax in ends:
                end_of_last = ends[pmax]
            prev = None                            # keep the sequence non-decreasing
            for p in range(pmin, pmax + 1):
                if prev is not None and start[p] < prev:
                    start[p] = prev
                prev = start[p]

        # -- group into ayahs with per-display-word start times
        refs = []
        for p in range(pmin, pmax + 1):
            if not refs or refs[-1] != matcher.pos_to_ref[p]:
                refs.append(matcher.pos_to_ref[p])
        first_entry = len(entries)
        for ref in refs:
            display = [w for w in re.split(r"\s+", matcher.arabic[ref].strip()) if w]
            ws = [None] * len(display)
            for p in range(pmin, pmax + 1):
                if matcher.pos_to_ref[p] == ref:
                    wi = matcher.pos_to_word[p]
                    ws[wi] = start[p] if ws[wi] is None else min(ws[wi], start[p])
            heard = [x for x in ws if x is not None]
            if not heard:
                continue
            # Pause marks and unheard words borrow the next word's start.
            nxt = None
            for i in range(len(ws) - 1, -1, -1):
                if ws[i] is None:
                    ws[i] = nxt
                else:
                    nxt = ws[i]
            last = max(heard)
            ws = [last if x is None else x for x in ws]
            # Words forced into a sliver of audio were not really recited here.
            if ctc is not None and len(ws) > 1 and (max(ws) - min(ws)) < 0.08 * len(ws):
                continue
            entries.append({
                **matcher._ayah(ref),
                "t0": round(min(heard), 2),
                "t1": None,
                "w": [round(x, 2) for x in ws],
            })
        # ayah end = next ayah's start; the passage's last ayah ends with its last word
        for k in range(first_entry, len(entries)):
            nxt_t0 = entries[k + 1]["t0"] if k + 1 < len(entries) else None
            entries[k]["t1"] = nxt_t0 if nxt_t0 is not None else round(max(end_of_last, entries[k]["w"][-1] + 0.2), 2)
        if len(entries) > first_entry:
            time_floor = entries[-1]["t1"]
            summary.append({
                "from": entries[first_entry]["ref"],
                "to": entries[-1]["ref"],
                "t0": entries[first_entry]["t0"],
                "t1": entries[-1]["t1"],
                "ayahs": len(entries) - first_entry,
            })

    entries.sort(key=lambda e: e["t0"])
    for k in range(len(entries) - 1):
        if entries[k]["t1"] > entries[k + 1]["t0"]:
            entries[k]["t1"] = entries[k + 1]["t0"]
    # A lone 1:1 right before another surah's first ayah is that surah's basmala.
    for k in range(len(entries) - 1):
        e, n = entries[k], entries[k + 1]
        if e["ref"] == "1:1" and n["ayah"] == 1 and n["surah"] != 1:
            e["basmala"] = True
            e["surahMeta"] = n["surahMeta"]
    return {"ayahs": entries, "passages": summary, "heardWords": len(toks),
            "precise": ctc is not None and audio is not None}


# ---------------------------------------------------------------------- video fetch
def fetch_audio(url: str, progress=None):
    """Download the best audio track with yt-dlp. -> (key, info, path)"""
    import yt_dlp

    CACHE_DIR.mkdir(exist_ok=True)
    quiet = {"quiet": True, "no_warnings": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(quiet) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("is_live"):
        raise RuntimeError("This is a live stream — use Listen live instead.")
    key = re.sub(r"[^A-Za-z0-9_-]", "_", f'{info.get("extractor_key", "media")}_{info.get("id", "x")}')
    existing = [p for p in CACHE_DIR.glob(key + ".*") if p.suffix not in (".json", ".part")]
    if existing:
        return key, info, existing[0]

    def hook(d):
        if progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                progress(d.get("downloaded_bytes", 0) / total)

    opts = {**quiet, "format": "bestaudio/best", "outtmpl": str(CACHE_DIR / (key + ".%(ext)s")),
            "progress_hooks": [hook]}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = [p for p in CACHE_DIR.glob(key + ".*") if p.suffix not in (".json", ".part")]
    if not files:
        raise RuntimeError("Download produced no audio file.")
    return key, info, files[0]


def fetch_direct(page_url: str, media_url: str, progress=None):
    """Download the media file the page itself is playing. Used when yt-dlp
    can't fetch a page (Instagram and TikTok often demand a login), since the
    browser already has a working, signed link to the file."""
    import hashlib
    import urllib.request
    from urllib.parse import urlsplit

    CACHE_DIR.mkdir(exist_ok=True)
    key = "Direct_" + hashlib.sha1(page_url.split("?")[0].encode()).hexdigest()[:16]
    path = CACHE_DIR / (key + ".media")
    if not path.exists():
        u = urlsplit(page_url)
        req = urllib.request.Request(media_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Referer": f"{u.scheme}://{u.netloc}/",
        })
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                buf = r.read(1 << 16)
                if not buf:
                    break
                f.write(buf)
                done += len(buf)
                if progress and total:
                    progress(done / total)
    return key, {"title": ""}, path


def align_url(asr, matcher, ctc, url: str, multilingual=True, progress=None, force=False, media=None):
    """Full pipeline for a video URL, cached on disk by video id."""
    def stage(name, frac=None):
        if progress:
            progress(name, frac)

    # YouTube ids are in the URL, so a repeat sync can skip the network entirely.
    yt = re.search(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})", url)
    if yt and not force:
        quick = CACHE_DIR / f"Youtube_{yt.group(1)}.json"
        if quick.exists():
            return json.loads(quick.read_text("utf-8"))

    stage("download", 0.0)
    try:
        key, info, path = fetch_audio(url, lambda f: stage("download", f))
    except Exception as err:
        if not (media and media.startswith("http")):
            if media and media.startswith("blob:"):
                raise RuntimeError("This site streams its video in a way that can't be downloaded. "
                                   "Use Listen live for this one.") from err
            raise
        print(f"  page download failed ({str(err).splitlines()[-1][:120]}); using the page's own media link")
        key, info, path = fetch_direct(url, media, lambda f: stage("download", f))
    cached = CACHE_DIR / (key + ".json")
    if cached.exists() and not force:
        return json.loads(cached.read_text("utf-8"))

    stage("transcribe", 0.0)
    audio = load_audio(path)
    chunks = transcribe_chunks(asr, audio, multilingual, progress=lambda f: stage("transcribe", f))
    stage("align", 0.0)
    tl = build_timeline(matcher, chunks, audio, ctc, progress=lambda f: stage("align", f))
    tl.update(key=key, title=info.get("title") or "", duration=round(len(audio) / SR, 2))
    cached.write_text(json.dumps(tl, ensure_ascii=False), "utf-8")
    return tl
