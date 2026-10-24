/** Tab capture, with browser-only CPU inference or the optional Python helper. */
import { AudioWindow } from './audio-window.js';
import { RecognitionScheduler } from './recognition-scheduler.js';

const SERVER_URL = 'ws://127.0.0.1:8790';
const SAMPLE_RATE = 16000; // must match the server

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let ws = null;
let running = false;
let framesSeen = 0;
let heartbeat = null;
let playback = null;
let recognitionWorker = null;
let recognitionTimer = null;
let modelLoadTimer = null;
let backend = 'helper';
let busy = false;
let ready = false;
let generation = 0;
let captureSession = 0;
let inFlightClock = null;
let lastClock = null;
let mediaPlaying = true;
const windowAudio = new AudioWindow(SAMPLE_RATE * 10);
const scheduler = new RecognitionScheduler(SAMPLE_RATE);

function resetRecognition(keepContext = false) {
  generation++;
  windowAudio.reset();
  scheduler.reset(keepContext && scheduler.locked);
  recognitionWorker?.postMessage({ type: 'reset', keepContext });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
}

function connectBrowser() {
  debug('Loading CPU model…');
  recognitionWorker = new Worker(new URL('./recognition-worker.js', import.meta.url), { type: 'module' });
  const fail = (error) => {
    stopCapture();
    send({ type: 'ERROR', error: `Browser recognition failed: ${error}` });
  };
  recognitionWorker.onerror = (e) => fail(e.message);
  modelLoadTimer = setTimeout(() => fail('CPU model loading timed out. Reload the extension and try again.'), 60000);
  recognitionWorker.onmessage = ({ data }) => {
    if (!running) return;
    if (data.type === 'ready') {
      clearTimeout(modelLoadTimer);
      modelLoadTimer = null;
      ready = true;
      send({ type: 'STATUS', status: 'listening' });
      debug('Listening on CPU.');
    } else if (data.type === 'progress') {
      send({ type: 'MODEL_PROGRESS', progress: data });
    } else if (data.type === 'error') {
      fail(data.error);
    } else if (data.type === 'result') {
      const clock = inFlightClock;
      inFlightClock = null;
      busy = false;
      if (data.generation !== generation) return;
      scheduler.update(data.tracking);
      debug(`CPU: ${data.ms} ms · ${data.tracking?.phase || 'identifying'} · ${data.match?.ref || 'awaiting confirmation'}`);
      if (data.match) send({ type: 'RESULT', match: data.match, clock });
    }
  };
  recognitionWorker.postMessage({ type: 'init', baseURL: chrome.runtime.getURL('') });
  recognitionTimer = setInterval(() => {
    if (!running || !ready || busy) return;
    const reason = mediaPlaying ? scheduler.due() : null;
    if (!reason) return;
    const audio = windowAudio.snapshot(SAMPLE_RATE * (scheduler.locked ? 6 : 10));
    scheduler.submittedNow();
    busy = true;
    const submittedGeneration = generation;
    // Stamp the end of captured audio BEFORE ASR, not when inference completes.
    captureClock().then((clock) => {
      if (!running || submittedGeneration !== generation || clock?.seeking || clock?.paused) {
        busy = false;
        return;
      }
      if (clock && lastClock && (clock.key !== lastClock.key || Math.abs(clock.duration - lastClock.duration) > 2)) {
        lastClock = clock;
        resetRecognition();
        busy = false;
        return;
      }
      if (clock) lastClock = clock;
      inFlightClock = clock;
      recognitionWorker.postMessage({ type: 'audio', audio, generation }, [audio.buffer]);
    });
  }, 250); // Check cheaply; submit at most once per second, only when idle.
}

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
function debug(text) {
  console.log('[qlt]', text);
  send({ type: 'DEBUG', text });
}
// A slow tab or asleep service worker must not leave recognition stuck on `busy`.
function captureClock(ms = 1500) {
  let timer;
  return Promise.race([
    chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' }).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function serverUnreachable() {
  send({
    type: 'ERROR',
    error: 'Local recognition server not reachable. Start it (server/run.bat), then click Start again.',
  });
}

// --- WebSocket to the local server ------------------------------------------
function connectServer() {
  send({ type: 'STATUS', status: 'loading-model' });
  debug('Connecting to local recognition server…');
  try {
    ws = new WebSocket(SERVER_URL);
  } catch {
    serverUnreachable();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => debug('Connected — waiting for the model…');
  ws.onmessage = (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.type === 'ready') {
      send({ type: 'STATUS', status: 'listening' });
      debug('Server ready — listening for recitation.');
    } else if (d.type === 'result' && d.match) {
      send({ type: 'RESULT', match: d.match });
    }
  };
  ws.onerror = () => {
    if (running) serverUnreachable();
  };
  ws.onclose = () => {
    if (running) serverUnreachable();
  };
}

// --- Capture ----------------------------------------------------------------
async function startCapture(streamId, mode = 'helper') {
  if (running) return;
  running = true;
  const session = ++captureSession;
  backend = mode;
  lastClock = null;
  mediaPlaying = true;
  resetRecognition();
  send({ type: 'STATUS', status: 'loading-model' });
  playback = document.getElementById('playback');

  try {
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    if (!running || session !== captureSession) {
      captured.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStream = captured;
  } catch (err) {
    if (session !== captureSession) return;
    stopCapture();
    send({ type: 'ERROR', error: `Capture failed: ${err?.message || err}` });
    return;
  }

  // Keep the tab audible.
  playback.srcObject = mediaStream;
  playback.play().catch(() => {});

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await audioContext.resume(); // offscreen has no gesture; context can start suspended
  } catch {}

  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL('worklet/capture-worklet.js'),
  );
  if (!running || session !== captureSession) return;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'qlt-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  workletNode.port.onmessage = (e) => {
    if (!running) return;
    framesSeen++;
    if (backend === 'browser') {
      if (mediaPlaying) {
        windowAudio.push(e.data);
        scheduler.push(e.data);
      }
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(e.data.buffer); // Float32 PCM, transferred from the worklet
    }
  };

  const silent = audioContext.createGain();
  silent.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silent);
  silent.connect(audioContext.destination); // pulls the graph; worklet outputs silence

  mediaStream.getAudioTracks().forEach((t) => {
    t.addEventListener('ended', () => stopCapture());
  });

  running = true;
  framesSeen = 0;
  if (backend === 'browser') connectBrowser();
  else connectServer();

  clearInterval(heartbeat);
  let lastFrames = 0;
  heartbeat = setInterval(() => {
    if (!running) return;
    if (framesSeen === lastFrames) {
      debug('No audio frames — is the tab actually playing sound (not muted)?');
    }
    lastFrames = framesSeen;
  }, 5000);
}

function stopCapture() {
  running = false;
  captureSession++;
  clearTimeout(modelLoadTimer);
  modelLoadTimer = null;
  generation++;
  clearInterval(recognitionTimer);
  recognitionTimer = null;
  recognitionWorker?.terminate();
  recognitionWorker = null;
  ready = busy = false;
  inFlightClock = null;
  windowAudio.reset();
  clearInterval(heartbeat);
  heartbeat = null;
  try {
    ws && ws.close();
  } catch {}
  ws = null;
  try {
    workletNode?.disconnect();
    sourceNode?.disconnect();
  } catch {}
  try {
    audioContext?.close();
  } catch {}
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (playback) playback.srcObject = null;
  audioContext = mediaStream = sourceNode = workletNode = null;
  send({ type: 'STATUS', status: 'stopped' });
}

// --- Message routing --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.backend).catch((err) => {
        stopCapture();
        send({ type: 'ERROR', error: err.message || String(err) });
      });
      sendResponse?.({ ok: true });
      break;
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse?.({ ok: true });
      break;
    case 'RESET_CAPTURE':
      resetRecognition();
      sendResponse?.({ ok: true });
      break;
    case 'MEDIA_PLAYING':
      if (mediaPlaying !== msg.playing) resetRecognition(true);
      mediaPlaying = msg.playing;
      sendResponse?.({ ok: true });
      break;
  }
  return true;
});
