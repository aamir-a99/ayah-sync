// CPU look-ahead presentation gate. Processing may find a verse early, but do
// not expose partial startup cues until the upcoming audio has been analyzed.
export class StartupBuffer {
  constructor(seconds = 12) { this.seconds = seconds; this.reset(); }
  reset() { this.ready = false; }
  update(playhead, duration, from, until) {
    const target = Math.min(duration, playhead + this.seconds);
    const covered = from !== null && until !== null && from <= playhead && until >= target - 0.001;
    if (covered) this.ready = true;
    const required = Math.max(0, target - playhead);
    const prepared = Math.max(0, Math.min(required, (until ?? playhead) - playhead));
    return { ready: this.ready, preparedSeconds: prepared, requiredSeconds: required };
  }
}
