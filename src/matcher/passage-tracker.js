// A passage must be confirmed before UI updates; pauses never advance a verse.
export class PassageTracker {
  constructor(matcher) {
    this.matcher = matcher;
    this.reset();
  }

  reset(keepContext = false) {
    if (!keepContext) {
      this.anchor = null;
      this.current = null;
      this.locked = false;
    }
    this.pending = null;
    this.confirmations = 0;
    this.misses = 0;
  }

  state() {
    return { locked: this.locked, confirmations: this.confirmations,
      phase: this.locked ? 'tracking' : this.pending ? 'confirming' : 'identifying',
      ref: this.current?.ref || null, nextRef: this.current?.next?.ref || null,
      nearEnd: !!this.current && this.current.word >= this.current.wordCount - 2 };
  }

  accept(candidate) {
    const { alternatives, ...match } = candidate;
    this.anchor = candidate.pos;
    this.current = match;
    this.locked = true;
    this.misses = 0;
    this.pending = null;
    return match;
  }

  update(text) {
    if (this.locked) {
      const candidate = this.matcher.match(text, this.anchor, {
        localOnly: true, nearbyRefs: this.matcher.nearbyRefs(this.anchor), evidenceOnly: true,
      });
      if (candidate && candidate.score >= 0.35 && candidate.evidenceWords >= 2) {
        return this.accept(candidate);
      }
      // A single breath/noisy window must not send us to a different surah.
      if (++this.misses < 2) return null;
      this.reset();
    }
    let candidate = this.matcher.match(text, null, { evidenceOnly: true });
    if (!candidate || candidate.score < 0.6 || candidate.evidenceWords < 3) {
      if (++this.misses >= 2) {
        this.pending = null;
        this.confirmations = 0;
      }
      return null;
    }
    this.misses = 0;
    const prior = this.pending?.alternatives || (this.pending ? [this.pending] : []);
    const linked = (candidate.alternatives || [candidate]).filter((c) => prior.some((p) =>
      c.pos >= p.pos - 3 && c.pos <= p.pos + 40));
    const continuation = linked.length > 0;
    // Two separately ambiguous phrases can uniquely identify their sequence
    // (e.g. basmala followed by al-hamd). Repeating the SAME phrase is not new
    // evidence and must not resolve ambiguity by wishful forward prediction.
    const contextual = new Set(linked.map((c) => c.ref)).size === 1 &&
      linked.some((c) => prior.some((p) => c.pos >= p.pos + 2 && c.pos <= p.pos + 40));
    if (contextual) {
      const c = linked[0];
      candidate = { ...this.matcher.result(c.pos, c.score), evidenceWords: c.evidenceWords,
        alternatives: linked, ambiguous: false };
    }
    this.confirmations = continuation ? this.confirmations + 1 : 1;
    this.pending = candidate;
    // An isolated basmala/refrain has several identical locations. Gather more
    // surrounding audio rather than falsely claiming which surah it belongs to.
    if (this.confirmations >= 2 && !candidate.ambiguous) return this.accept(candidate);
    return null;
  }
}
