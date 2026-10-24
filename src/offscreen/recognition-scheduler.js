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
  }

  push(frame) {
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    const voiced = rms >= Math.max(0.0015, this.noiseFloor * 3);
    this.total += frame.length;
    if (voiced) {
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
    if (this.quiet >= 0.35 * sr) return 'speech-pause';
    // No clear pause (reverb/music/noise)? Fall back to periodic recognition.
    return fresh >= (this.nearEnd ? 2 : 4) * sr ? 'tracking-fallback' : null;
  }

  submittedNow() {
    this.submitted = this.total;
    this.freshVoice = 0;
  }
}
