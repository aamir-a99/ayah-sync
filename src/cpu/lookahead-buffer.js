import { normalizeArabic } from './match.js';

export function alignTimedWords(words, ayah) {
  const canon = ayah.arabic.trim().split(/\s+/).map(normalizeArabic);
  const heard = words.map((w) => normalizeArabic(w.text));
  const rows = Array.from({ length: heard.length + 1 }, () => new Uint16Array(canon.length + 1));
  for (let i = 1; i <= heard.length; i++) {
    for (let j = 1; j <= canon.length; j++) {
      rows[i][j] = heard[i - 1] && heard[i - 1] === canon[j - 1] ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const pairs = [];
  let i = heard.length, j = canon.length;
  while (i && j) {
    if (heard[i - 1] && heard[i - 1] === canon[j - 1]) {
      pairs.push({ word: j - 1, start: words[i - 1].start, end: words[i - 1].end });
      i--; j--;
    } else if (rows[i - 1][j] > rows[i][j - 1]) i--;
    else j--;
  }
  return pairs.reverse();
}

// Small rolling timing buffer, not a whole-video recognition job. Only verses
// accepted by the unchanged passage tracker are eligible for timed display.
export class LookaheadBuffer {
  constructor() { this.reset(); }
  reset() { this.cues = []; this.history = []; this.from = this.until = null; this.observations = new WeakMap(); }
  applyAlignments(windows) {
    for (const window of windows || []) {
      for (const cue of this.cues.filter((c) => c.match.ref === window.ref)) {
        let observations = this.observations.get(cue);
        if (!observations) { observations = new Map(); this.observations.set(cue, observations); }
        for (const span of window.spans) {
          const start = window.start + span.start, end = window.start + span.end;
          if (start < cue.t0 - 0.2 || end <= start) continue;
          const samples = observations.get(span.word) || new Map();
          samples.set(window.start, { start, end, confidence: span.confidence,
            quality: span.confidence * (0.25 + Math.min(0.75, Math.max(0, Math.min(span.start, window.duration - span.end)))) });
          if (samples.size > 24) samples.delete(samples.keys().next().value);
          observations.set(span.word, samples);
        }
        const median = (values) => {
          values.sort((a, b) => a - b);
          const i = Math.floor(values.length / 2);
          return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
        };
        const words = [...observations].map(([word, samples]) => {
          const values = [...samples.values()];
          // Do not take min(start)/max(end): a single bad overlapping window
          // otherwise stretches a highlight across the following words.
          let best = [], weight = -1;
          for (const seed of values) {
            const cluster = values.filter((w) => Math.abs(w.start - seed.start) <= 0.3 && Math.abs(w.end - seed.end) <= 0.5);
            const score = cluster.reduce((sum, w) => sum + w.quality, 0);
            if (score > weight) { best = cluster; weight = score; }
          }
          return { word, start: median(best.map((w) => w.start)), end: median(best.map((w) => w.end)) };
        }).sort((a, b) => a.word - b.word);
        // Never overlap two highlights or extrapolate through a missing word.
        for (let i = 0; i < words.length - 1; i++) words[i].end = Math.min(words[i].end, words[i + 1].start);
        cue.highlightWords = words.filter((w) => w.end > w.start);
      }
    }
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i], until = this.cues[i + 1]?.t0 ?? this.until;
      if (cue.highlightWords) cue.highlightWords = cue.highlightWords.map((w) => ({ ...w, end: Math.min(w.end, until) }))
        .filter((w) => w.end > w.start);
    }
  }
  add(start, duration, result, playhead) {
    this.from ??= start;
    this.until = start + duration;
    this.history.push({ start, words: result.timedWords || [] });
    this.history = this.history.filter((w) => w.start >= start - 8);
    const match = result.timingMatch;
    if (!match) return;
    let cue = this.cues.at(-1);
    const continuing = cue?.match.ref === match.ref;
    const lower = continuing ? cue.lower : cue?.lastEnd ?? this.from;
    const candidates = this.history.flatMap((window) => {
      const pairs = alignTimedWords(window.words, match).map((w) => ({ ...w,
        start: w.start + window.start, end: w.end + window.start }));
      return pairs.length >= Math.min(2, match.wordCount) ? pairs.filter((w) => w.start >= lower) : [];
    });
    if (candidates.length < Math.min(2, match.wordCount)) return;
    if (!continuing) {
      cue = { match, lower, t0: Math.min(...candidates.map((w) => w.start)), words: [], lastEnd: lower };
      this.cues.push(cue);
    }
    for (const span of candidates) {
      const old = cue.words.find((w) => w.word === span.word);
      if (!old) cue.words.push({ ...span });
      else {
        old.start = Math.min(old.start, span.start);
        old.end = Math.max(old.end, span.end);
      }
    }
    cue.words.sort((a, b) => a.start - b.start);
    cue.t0 = Math.max(cue.lower, Math.min(cue.t0, cue.words[0].start));
    cue.lastEnd = Math.max(...cue.words.map((w) => w.end));
    // Retain a short seek-back buffer. PCM itself is cached separately in one
    // bounded block; long videos cannot accumulate unbounded tab/session data.
    while (this.cues.length > 1 && this.cues[1].t0 < playhead - 30) this.cues.shift();
  }
  payload() { return { from: this.from, until: this.until, cues: this.cues }; }
}
