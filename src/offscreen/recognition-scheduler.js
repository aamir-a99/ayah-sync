// Cheap energy-based pause hint, not a neural VAD or an ayah-boundary detector.
// All clocks are captured sample counts, so slow inference cannot build a queue.
export class RecognitionScheduler {
  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset(keepContext = false) {
    this.locked = !!keepContext;
    this.nearEnd = false;
    this.total = this.submitted = this.voiced = this.freshVoice = this.quiet = 0;
    this.noiseFloor = 0.0005;
    this.phraseStart = 0;
    this.phrase = this.submittedPhrase = 0;
  }

  push(frame) {
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    const voiced = rms >= Math.max(0.0015, this.noiseFloor * 3);
    this.total += frame.length;
    if (voiced) {
      if (this.quiet >= 0.35 * this.sampleRate) {
        this.phraseStart = Math.max(0, this.total - frame.length - Math.round(0.15 * this.sampleRate));
        this.phrase++;
      }
      this.voiced += frame.length;
      this.freshVoice += frame.length;
      this.quiet = 0;
    } else {
      this.quiet += frame.length;
      this.noiseFloor = this.noiseFloor * 0.95 + Math.min(rms, 0.003) * 0.05;
    }
  }

  update(state) {
    this.locked = !!state?.locked;
    this.nearEnd = !!state?.nearEnd;
  }

  due() {
    const sr = this.sampleRate;
    const fresh = this.total - this.submitted;
    if (!this.locked) {
      // Start with six seconds, then a longer fresh-context confirmation.
      return this.total >= 6 * sr && this.voiced >= 2 * sr &&
        this.freshVoice >= 0.5 * sr && (!this.submitted || fresh >= 2 * sr)
        ? 'confirm-passage' : null;
    }
    if (this.freshVoice < 0.5 * sr || fresh < 1.2 * sr) return null;
    // After a breath, inspect the new phrase instead of the preceding ayah.
    if (this.phrase > this.submittedPhrase && this.quiet < 0.35 * sr &&
        this.total - this.phraseStart >= 2.5 * sr && this.freshVoice >= 1.5 * sr) return 'phrase-start';
    if (this.quiet >= 0.35 * sr) {
      // Avoid recognising virtually the same phrase twice at start and end.
      return this.freshVoice >= 3 * sr || this.nearEnd ? 'speech-pause' : null;
    }
    // No clear pause (reverb/music/noise)? Fall back to periodic recognition.
    return fresh >= (this.nearEnd ? 4 : 8) * sr ? 'tracking-fallback' : null;
  }

  submittedNow() {
    this.submitted = this.total;
    this.freshVoice = 0;
    this.submittedPhrase = this.phrase;
  }

  pauseTail() {
    // Keep a little breath/reverb context, but do not let a long pause replace
    // the words just spoken in the rolling recognition window.
    return Math.max(0, this.quiet - Math.round(0.15 * this.sampleRate));
  }

  windowSamples(reason) {
    const sr = this.sampleRate;
    if (!this.locked) return 10 * sr;
    if (reason === 'phrase-start') return Math.min(6 * sr, this.total - this.phraseStart);
    if (reason === 'speech-pause') return 8 * sr;
    return 6 * sr;
  }
}
