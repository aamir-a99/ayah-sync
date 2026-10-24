import { env, pipeline } from '@huggingface/transformers';
import { QuranMatcher } from '../matcher/match.js';
import { PassageTracker } from '../matcher/passage-tracker.js';
import arabic from '../data/quran-uthmani.json';
import english from '../data/quran-en.json';
import surahs from '../data/surahs.json';
import indopak from '../data/quran-indopak.json';

// Explicit CPU/WASM: no GPU, remote model/code or shared-memory requirement.
export async function createRecognizer(baseURL, progress = () => {}) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false; // Everything ships in the unpacked extension.
  env.localModelPath = new URL('models/', baseURL).href;
  env.backends.onnx.wasm.wasmPaths = new URL('ort/', baseURL).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  const asr = await pipeline('automatic-speech-recognition', 'quran-tiny', {
    device: 'wasm', dtype: 'q8', local_files_only: true, progress_callback: progress,
    // Fuse supported WASM operations for repeated live inference.
    session_options: { graphOptimizationLevel: 'all' },
  });
  const matcher = new QuranMatcher(arabic, english, surahs, indopak);
  const tracker = new PassageTracker(matcher);
  let epoch = 0;
  return {
    threads: 1,
    reset(keepContext = false) { tracker.reset(keepContext); epoch++; },
    async recognize(audio) {
      const passage = tracker;
      const startedEpoch = epoch;
      const start = performance.now();
      let peak = 0;
      for (const value of audio) peak = Math.max(peak, Math.abs(value));
      if (peak < 0.005) return { match: null, text: '', ms: 0, tracking: passage.state() };
      const normalized = Float32Array.from(audio, (x) => x / peak);
      const output = await asr(normalized, {
        // Short windows must not spend time generating a 100-token hallucination.
        max_new_tokens: Math.min(100, Math.max(32, Math.ceil(audio.length / 16000 * 8))),
        num_beams: 1, do_sample: false,
        return_timestamps: false,
      });
      const text = output.text || '';
      if (startedEpoch !== epoch) {
        return { match: null, text: '', ms: Math.round(performance.now() - start) };
      }
      const match = passage.update(text);
      return { match, text, ms: Math.round(performance.now() - start), tracking: passage.state() };
    },
  };
}
