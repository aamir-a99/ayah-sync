/**
 * AudioWorklet processor: collects mono PCM from the tab-capture stream and
 * posts it to the offscreen document in ~4096-sample batches. Replaces the
 * deprecated ScriptProcessorNode — runs on the audio thread, so it doesn't
 * glitch when the main thread is busy transcribing.
 */
class QltCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._len = 0;
    this._target = 4096;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._chunks.push(new Float32Array(ch));
      this._len += ch.length;
      if (this._len >= this._target) {
        const out = new Float32Array(this._len);
        let o = 0;
        for (const c of this._chunks) {
          out.set(c, o);
          o += c.length;
        }
        // Transfer the buffer (zero-copy) to the main thread.
        this.port.postMessage(out, [out.buffer]);
        this._chunks = [];
        this._len = 0;
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('qlt-capture', QltCaptureProcessor);
