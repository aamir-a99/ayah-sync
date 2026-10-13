/**
 * Offscreen document: audio capture + streaming client.
 *
 * The recognition itself runs in the local Python server (fast + accurate). This
 * document does only what the browser alone can do:
 *   1. Rehydrate the tab-capture MediaStream from a streamId.
 *   2. Play it back so the user still hears the tab.
 *   3. Tap it at 16 kHz via an AudioWorklet and stream raw Float32 PCM to the
 *      local server over a WebSocket.
 *   4. Relay the server's verse matches back to the service worker → card.
 */

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

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
function debug(text) {
  console.log('[qlt]', text);
  send({ type: 'DEBUG', text });
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
async function startCapture(streamId) {
  if (running) return;
  playback = document.getElementById('playback');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (err) {
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
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'qlt-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  workletNode.port.onmessage = (e) => {
    if (!running) return;
    framesSeen++;
    if (ws && ws.readyState === WebSocket.OPEN) {
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
  connectServer();

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
      startCapture(msg.streamId);
      sendResponse?.({ ok: true });
      break;
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse?.({ ok: true });
      break;
  }
  return true;
});
