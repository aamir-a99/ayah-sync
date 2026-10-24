import { createRecognizer } from './local-recognizer.js';

let recognizer;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      recognizer = await createRecognizer(data.baseURL, (p) => {
        if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
      });
      self.postMessage({ type: 'ready', threads: recognizer.threads || 1 });
    } else if (data.type === 'reset') {
      recognizer?.reset(data.keepContext);
    } else if (data.type === 'audio' && recognizer) {
      self.postMessage({ type: 'result', generation: data.generation, ...await recognizer.recognize(data.audio) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message || String(error) });
  }
};
