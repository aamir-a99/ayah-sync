import { LookaheadBuffer } from './lookahead-buffer.js';
import { StartupBuffer } from './startup-buffer.js';

const SR = 16000;
const AHEAD = 12;

// Exclusive alternative to live tab capture. One worker, one PCM block, one
// outstanding request; no continuous loop while the look-ahead buffer is full.
export function startLookahead({ url, media, key, captureEpoch, highlightEnabled = false }, send) {
  let stopped = false, generation = 0, epoch = captureEpoch;
  let worker = null, workerRequest = null, audioRequest = null;
  let socket = null, socketReady = false, initialized = false;
  let source = null, block = null, cursor = null, requestId = 0;
  let lastPlayhead = null;
  let timer = null;
  let alignWords = highlightEnabled, refinePending = false;
  const buffer = new LookaheadBuffer();
  const startup = new StartupBuffer(AHEAD);
  function publish(playhead) {
    const progress = startup.update(playhead, source.duration, buffer.from, buffer.until);
    send({ type: 'BUFFER', key, duration: source.duration, ...buffer.payload(), ...progress,
      cues: progress.ready ? buffer.cues : [], captureEpoch: epoch });
  }
  const setHighlight = (enabled) => {
    alignWords = enabled === true;
    refinePending = alignWords;
  };
  const debug = (text) => send({ type: 'DEBUG', text: `CPU look-ahead · ${text}` });
  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(workerRequest?.timer);
    clearTimeout(audioRequest?.timer);
    worker?.terminate(); socket?.close();
    workerRequest?.reject(new Error('Stopped'));
    audioRequest?.reject(new Error('Stopped'));
    workerRequest = audioRequest = null;
    block = null;
  }
  function fail(error) {
    if (stopped) return;
    stop();
    send({ type: 'ERROR', error: `CPU look-ahead: ${error.message || error}. Use CPU live-only if this video cannot be downloaded.` });
  }
  function askWorker(data) {
    return new Promise((resolve, reject) => {
      workerRequest = { resolve, reject, timer: setTimeout(() => reject(new Error('CPU worker timed out')), 60000) };
      worker.postMessage(data, data.audio ? [data.audio.buffer] : []);
    });
  }
  async function loadWorker(maxThreads = 4) {
    worker = new Worker(new URL('./recognition-worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (e) => workerRequest?.reject(new Error(e.message));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') send({ type: 'MODEL_PROGRESS', progress: data });
      else if (data.type === 'error') {
        clearTimeout(workerRequest?.timer);
        workerRequest?.reject(new Error(data.error));
      } else {
        clearTimeout(workerRequest?.timer);
        workerRequest?.resolve(data); workerRequest = null;
      }
    };
    try {
      return await askWorker({ type: 'init', baseURL: chrome.runtime.getURL(''), maxThreads });
    } catch (error) {
      if (maxThreads === 1 || stopped) throw error;
      worker.terminate();
      return loadWorker(1);
    }
  }
  function requestAudio(start) {
    return new Promise((resolve, reject) => {
      audioRequest = { id: ++requestId, resolve, reject,
        timer: setTimeout(() => reject(new Error('Audio window timed out')), 45000) };
      socket.send(JSON.stringify({ type: 'cpu_audio_window', id: requestId, start, seconds: 20 }));
    });
  }
  function reset(nextEpoch) {
    epoch = nextEpoch ?? epoch;
    generation++;
    cursor = null; lastPlayhead = null; block = null; buffer.reset(); startup.reset();
    // An outstanding single-flight inference is allowed to finish and is
    // discarded by generation. The reset message is processed before new audio.
    worker?.postMessage({ type: 'reset' });
    send({ type: 'BUFFER', key, duration: source?.duration, ...buffer.payload(), ready: false,
      preparedSeconds: 0, requiredSeconds: AHEAD, captureEpoch: epoch });
  }
  async function loop() {
    if (stopped) return;
    try {
      const clock = await chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' });
      if (!clock || clock.key !== key || !Number.isFinite(clock.time)) {
        timer = setTimeout(loop, 1000); return;
      }
      if (clock.seeking || Math.abs(clock.duration - source.duration) > 5) {
        timer = setTimeout(loop, 500); return;
      }
      if (cursor === null || clock.time < (buffer.from ?? clock.time) || clock.time > cursor + 12 ||
          (lastPlayhead !== null && Math.abs(clock.time - lastPlayhead) > 4)) {
        reset(epoch);
        cursor = Math.max(0, Math.floor(clock.time) - 10);
      }
      lastPlayhead = clock.time;
      const submitted = generation;
      if (alignWords && refinePending && buffer.cues.length) {
        refinePending = false;
        const result = await askWorker({ type: 'align', cues: buffer.cues.map((cue, i) => ({
          match: cue.match, t0: cue.t0, until: buffer.cues[i + 1]?.t0 ?? buffer.until,
          complete: i + 1 < buffer.cues.length,
        })) });
        if (stopped) return;
        if (submitted !== generation) { timer = setTimeout(loop, 0); return; }
        buffer.applyAlignments(result.alignedWindows);
        publish(clock.time);
      }
      if (buffer.until >= source.duration - 0.001 || cursor >= clock.time + AHEAD) {
        debug(`buffer ready · ${Math.max(0, cursor - clock.time).toFixed(0)}s ahead`);
        timer = setTimeout(loop, 1000); return;
      }
      // Include the final partial second (and videos shorter than four seconds)
      // so the 12-second gate can also complete near the end of a video.
      cursor = Math.min(cursor, Math.max(0, source.duration - 4));
      if (!block || cursor < block.start || cursor + 4 > block.start + block.audio.length / SR) {
        const data = await requestAudio(cursor);
        if (stopped || submitted !== generation) { timer = setTimeout(loop, 0); return; }
        if (data.sampleRate !== SR || typeof data.pcm !== 'string' || data.pcm.length > 24 * SR * 4 * 4 / 3 + 4) {
          throw new Error('Invalid or oversized audio window');
        }
        const bytes = Uint8Array.from(atob(data.pcm), (c) => c.charCodeAt(0));
        block = { start: data.start, audio: new Float32Array(bytes.buffer) };
      }
      const offset = Math.round((cursor - block.start) * SR);
      const samples = Math.round(Math.min(4, source.duration - cursor) * SR);
      const audio = block.audio.slice(offset, offset + samples);
      if (audio.length < samples - 1 || !audio.length) throw new Error('Audio ended before the requested window');
      const start = cursor;
      const audioDuration = audio.length / SR;
      const result = await askWorker({ type: 'audio', audio, generation: submitted, freshSeconds: 1,
        timings: true, audioStart: start, alignWords });
      if (stopped) return;
      if (submitted === generation) {
        buffer.add(start, audioDuration, result, clock.time);
        if (alignWords && buffer.cues.length) {
          const alignment = await askWorker({ type: 'align', cues: buffer.cues.map((cue, i) => ({
            match: cue.match, t0: cue.t0, until: buffer.cues[i + 1]?.t0 ?? buffer.until,
            complete: i + 1 < buffer.cues.length,
          })) });
          if (stopped) return;
          if (submitted !== generation) { timer = setTimeout(loop, 0); return; }
          buffer.applyAlignments(alignment.alignedWindows);
        }
        cursor++;
        publish(clock.time);
        debug(`recognizing ahead · ${result.ms}ms · ${Math.max(0, cursor - clock.time).toFixed(0)}s buffered`);
      }
      // Bound burst CPU duty to roughly one third, then sleep completely once
      // prepared. Steady playback needs only one four-second inference/second.
      timer = setTimeout(loop, Math.max(100, (result.ms || 0) * 2));
    } catch (error) { fail(error); }
  }
  async function begin() {
    if (initialized || !source || !socketReady || stopped) return;
    initialized = true;
    debug('loading CPU model…');
    try {
      const ready = await loadWorker();
      if (stopped) return;
      debug(`${ready.threads} thread(s) · preparing the next ${AHEAD}s`);
      send({ type: 'STATUS', status: 'listening' });
      loop();
    } catch (error) { fail(error); }
  }
  debug('fetching video audio in background…');
  socket = new WebSocket('ws://127.0.0.1:8790');
  socket.onopen = () => socket.send(JSON.stringify({ type: 'cpu_audio_prepare', url, media }));
  socket.onerror = () => fail(new Error('Audio helper unavailable'));
  socket.onclose = () => { if (!stopped) fail(new Error('Audio helper disconnected')); };
  socket.onmessage = ({ data: message }) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'ready') socketReady = true;
      else if (data.type === 'cpu_audio_progress') debug(`fetching audio · ${Math.round(data.pct * 100)}%`);
      else if (data.type === 'cpu_audio_error') throw new Error(data.error);
      else if (data.type === 'cpu_audio_ready') {
        if (data.sampleRate !== SR || !Number.isFinite(data.duration)) throw new Error('Invalid audio metadata');
        source = data;
      } else if (data.type === 'cpu_audio_window' && audioRequest?.id === data.id) {
        clearTimeout(audioRequest.timer);
        audioRequest.resolve(data); audioRequest = null;
      }
      begin();
    } catch (error) { fail(error); }
  };
  return { stop, reset, setHighlight };
}
