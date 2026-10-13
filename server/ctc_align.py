"""
CTC forced alignment: given audio and the EXACT words recited in it, find when
each word starts and ends. This is the same technique quran.com used to build
its word-by-word timings.

An Arabic wav2vec2 CTC model turns audio into per-20ms letter probabilities; a
Viterbi pass then finds the best monotone path of the known letter sequence
through those frames.
"""
import re

import numpy as np

MODEL_ID = "jonatasgrosman/wav2vec2-large-xlsr-53-arabic"
FRAME_S = 0.02            # wav2vec2 emits one frame per 320 samples at 16 kHz
STAR_LOGP = float(np.log(0.3))   # per-frame score of "something that isn't our text"

_MARKS = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ]")


class CtcAligner:
    def __init__(self, model_id: str = MODEL_ID):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        self.torch = torch
        self.proc = Wav2Vec2Processor.from_pretrained(model_id)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.model = Wav2Vec2ForCTC.from_pretrained(model_id, torch_dtype=self.dtype).to(self.device).eval()
        self.vocab = self.proc.tokenizer.get_vocab()
        self.blank = self.proc.tokenizer.pad_token_id
        self.delim = self.vocab.get("|")

    def emissions(self, audio: np.ndarray) -> np.ndarray:
        """[T, V] log-probabilities for one stretch of 16 kHz mono audio."""
        torch = self.torch
        x = audio.astype(np.float32)
        x = (x - x.mean()) / (x.std() + 1e-7)
        with torch.inference_mode():
            inp = torch.from_numpy(x).to(self.device, self.dtype).unsqueeze(0)
            logits = self.model(inp).logits[0].float()
            return torch.log_softmax(logits, dim=-1).cpu().numpy()

    def encode(self, word: str):
        """Quran word -> the model's letter ids (marks stripped, wasla -> alef)."""
        w = _MARKS.sub("", word).replace("ٱ", "ا")
        return [self.vocab[c] for c in w if c in self.vocab and c not in "|-"]


def viterbi(em: np.ndarray, targets, blank: int, star_start=False, star_end=False):
    """Best CTC path of `targets` through `em`.

    -> [(first_frame, last_frame)] per target, or None if the audio is too
    short to hold the text. Optional "star" states at either end soak up audio
    that isn't part of the text (an isti'adha, applause, a cut-off word)."""
    T, V = em.shape
    L = len(targets)
    if L == 0 or T < L:
        return None
    em = np.concatenate([em, np.full((T, 1), STAR_LOGP, dtype=em.dtype)], axis=1)
    STAR = V
    ext = []
    if star_start:
        ext.append(STAR)
    for y in targets:
        ext += [blank, y]
    ext.append(blank)
    if star_end:
        ext.append(STAR)
    ext = np.array(ext)
    S = len(ext)
    # A state may be entered from two back when it is a letter that differs from
    # the letter (or star) two back — the usual CTC "skip the blank" rule.
    skip = np.zeros(S, dtype=bool)
    skip[2:] = (ext[2:] != blank) & (ext[2:] != ext[:-2])

    NEG = -1e30
    alpha = np.full(S, NEG, dtype=np.float64)
    alpha[0] = em[0, ext[0]]
    alpha[1] = em[0, ext[1]]
    if star_start and S > 2:
        alpha[2] = em[0, ext[2]]
    bp = np.zeros((T, S), dtype=np.uint8)
    for t in range(1, T):
        a1 = np.empty(S); a1[0] = NEG; a1[1:] = alpha[:-1]
        a2 = np.full(S, NEG); a2[2:] = np.where(skip[2:], alpha[:-2], NEG)
        stack = np.stack([alpha, a1, a2])
        k = np.argmax(stack, axis=0)
        bp[t] = k
        alpha = stack[k, np.arange(S)] + em[t, ext]

    finals = [S - 1, S - 2] + ([S - 3] if star_end else [])
    s = max(finals, key=lambda i: alpha[i])
    if alpha[s] <= NEG / 2:
        return None
    path = np.empty(T, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(bp[t, s])

    first = np.full(S, -1, dtype=np.int64)
    last = np.full(S, -1, dtype=np.int64)
    for t, st in enumerate(path):
        if first[st] < 0:
            first[st] = t
        last[st] = t
    base = (1 if star_start else 0) + 1
    out = []
    for i in range(L):
        st = base + 2 * i
        out.append((int(first[st]), int(last[st])))
    return out
