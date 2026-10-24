// Approximate, evidence-only observations. Never fill unheard gaps or synthesize
// future ayah boundaries from database order or inference completion time.
export class LearnedTimeline {
  constructor(key, duration, saved = null) {
    this.key = key;
    this.duration = duration;
    this.entries = saved?.key === key && Math.abs(saved.duration - duration) < 2
      ? (saved.entries || []).filter((e) => e.ref && Number.isFinite(e.t0) && Number.isFinite(e.t1)).slice(-1000) : [];
    this.run = Math.max(0, ...this.entries.map((e) => e.run || 0)) + 1;
  }

  breakRun() { this.run++; }

  observe(match, at) {
    if (!match?.ref || !Number.isFinite(at) || at < 0 || at > this.duration) return false;
    at = Math.round(at * 100) / 100;
    const previous = this.entries.findLast((e) => e.run === this.run);
    if (previous?.ref === match.ref && at >= previous.lastSeen && at - previous.lastSeen <= 6) {
      previous.lastSeen = at;
      previous.t1 = Math.min(this.duration, at + 0.75);
    } else {
      const { ref, surah, ayah, arabic, arabicIndopak, translation, surahMeta } = match;
      const entry = { ref, surah, ayah, arabic, arabicIndopak, translation, surahMeta,
        t0: at, t1: Math.min(this.duration, at + 0.75), lastSeen: at, run: this.run };
      // Revisiting an already observed point need not create duplicate markers.
      const overlap = this.entries.find((e) => e.ref === ref && e.t0 <= entry.t1 && e.t1 >= entry.t0);
      if (overlap) {
        Object.assign(overlap, { t0: Math.min(overlap.t0, entry.t0),
          t1: Math.max(overlap.t1, entry.t1), lastSeen: at, run: this.run });
      } else this.entries.push(entry);
    }
    this.entries.sort((a, b) => a.t0 - b.t0);
    this.entries = this.entries.slice(-1000);
    return true;
  }

  snapshot() {
    return { mode: 'learned', partial: true, approximate: true,
      key: this.key, duration: this.duration, entries: this.entries.map((e) => ({ ...e })) };
  }
}
