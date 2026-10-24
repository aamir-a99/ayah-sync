/**
 * Service worker: orchestration hub.
 *
 * SYNC (on-demand videos): popup ──SYNC_START──▶ here ──{align,url}──▶ helper
 *   The helper downloads the audio once and returns a word-level timeline; we
 *   hand it to the tab's content script, which follows video.currentTime.
 *
 * LIVE (streams):
 *   popup ──START/STOP──▶ service worker
 *                          │  getMediaStreamId(tab)  +  ensure offscreen doc
 *                          ▼
 *                       offscreen  ──STATUS/RESULT──▶ service worker
 *                                                      │
 *                                                      ├─▶ popup (broadcast, auto)
 *                                                      └─▶ content script (card) in the captured tab
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

const state = {
  capturing: false,
  tabId: null, // the CAPTURED audio tab
  displayTabId: null, // where the card is currently shown (follows the active tab)
  status: 'idle', // idle | loading-model | listening | stopped | error
  modelProgress: null,
  lastMatch: null,
  mediaPlaying: true, // captured tab's play/pause state
  debug: null, // last human-readable working state (diagnostics)
  error: null,
  backend: 'helper',
  captureEpoch: 0,
  // Whole-video sync: idle | working | ready | error
  sync: { status: 'idle', tabId: null, key: null, stage: null, pct: 0, summary: null, error: null },
};

const HELPER_URL = 'ws://127.0.0.1:8790';
const trCache = {}; // lang -> Promise<{ref: text}>
const HELPER_DOWN = 'The helper is not running. Open run.bat in the server folder, then try again.';

// The MV3 service worker is ephemeral — Chrome kills it when idle and re-spawns
// it on the next message, wiping in-memory `state`. Mirror state into
// chrome.storage.session so a revived SW (and a freshly opened popup) can read
// it instantly instead of waiting on the busy offscreen document.
const restored = chrome.storage.session
  .get('qltState')
  .then((r) => {
    if (r?.qltState) {
      for (const key of Object.keys(state)) {
        if (Object.hasOwn(r.qltState, key)) state[key] = r.qltState[key];
      }
    }
    // A sync that was mid-flight when the worker was recycled lost its socket.
    if (state.sync?.status === 'working') {
      state.sync = { ...state.sync, status: 'error', error: 'The sync was interrupted. Try again.' };
    }
  })
  .catch(() => {});

let broadcastTimer = null;
let lastBroadcast = 0;
function flushState() {
  chrome.storage.session.set({ qltState: state }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => {});
}

// --- Offscreen lifecycle ----------------------------------------------------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification:
      'Capture the active tab audio to transcribe Quran recitation on-device.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }
}

// Recover the captured tab id after a service-worker respawn (in-memory state is
// wiped, but we persisted it to storage.session). Without this, RESULT/STATUS
// messages from the offscreen doc get dropped and the card never updates.
async function resolveTabId() {
  if (state.tabId != null) return state.tabId;
  await restored;
  return state.tabId;
}

// Where the card should be drawn — follows the active tab, falling back to the
// captured tab.
async function resolveDisplayTabId() {
  if (state.displayTabId != null) return state.displayTabId;
  await restored;
  return state.displayTabId ?? state.tabId;
}

// The built content-script filename is hashed by Vite, so read it from the
// manifest rather than hardcoding a source path (the old hardcoded path made the
// re-injection fallback silently fail, so the card never appeared on tabs that
// were open before the extension was (re)loaded).
function contentScriptFiles() {
  try {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    return cs[0]?.js || [];
  } catch {
    return [];
  }
}

// --- Content-script card control --------------------------------------------
async function tellCard(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script missing (e.g. tab predates the extension load) — inject the
    // real built file, then retry.
    try {
      const files = contentScriptFiles();
      if (files.length) {
        await chrome.scripting.executeScript({ target: { tabId }, files });
        await chrome.tabs.sendMessage(tabId, message);
      }
    } catch {}
  }
}

async function captureClock() {
  const tabId = await resolveTabId();
  if (!state.capturing || tabId == null) return null;
  const epoch = state.captureEpoch;
  let timer;
  try {
    // A busy or frozen tab must not leave the caller waiting forever.
    const clock = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CLOCK' }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return clock ? { ...clock, captureEpoch: epoch } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- Whole-video sync ---------------------------------------------------------
/** Same key the content script derives, so a timeline is only reused for the
 *  video it was made for. */
function videoKey(href) {
  try {
    const u = new URL(href);
    const yt =
      (/(^|\.)youtube\.com$/.test(u.hostname) &&
        (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1])) ||
      (u.hostname === 'youtu.be' && u.pathname.slice(1, 12));
    return yt ? `yt:${yt}` : u.origin + u.pathname;
  } catch {
    return href;
  }
}

const STAGE_TEXT = {
  queued: 'Waiting for the helper…',
  download: 'Fetching the audio…',
  transcribe: 'Recognising the recitation…',
  align: 'Timing every word…',
};

/** Is the local helper running? Resolves {ok, model, device}. */
function pingHelper(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    try {
      ws = new WebSocket(HELPER_URL);
    } catch {
      return finish({ ok: false });
    }
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'ready') finish({ ok: true, model: d.model, device: d.device });
      } catch {}
    };
    ws.onerror = () => finish({ ok: false });
  });
}

function summarize(timeline) {
  return {
    title: timeline.title || '',
    ayahs: timeline.ayahs.length,
    duration: timeline.duration,
    passages: (timeline.passages || []).map((p) => ({ from: p.from, to: p.to, t0: p.t0, t1: p.t1 })),
    names: Object.fromEntries(
      timeline.ayahs.map((a) => [a.surah, a.surahMeta?.englishName || `Surah ${a.surah}`]),
    ),
  };
}

const IDLE_SYNC = { status: 'idle', tabId: null, key: null, stage: null, pct: 0, summary: null, error: null };

async function startSync(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    state.sync = { ...IDLE_SYNC, status: 'error', error: 'Open a page with a video first.' };
    return flushState();
  }
  if (state.capturing) await teardown(); // one mode at a time
  const key = videoKey(tab.url);
  state.sync = { ...IDLE_SYNC, status: 'working', tabId: tab.id, key, stage: 'queued' };
  flushState();
  tellCard(tab.id, { type: 'TL_PROGRESS', text: STAGE_TEXT.queued });

  // The page's own link to the video file: the helper's fallback when it can't
  // download from the page address (Instagram / TikTok often need a login).
  let media = null;
  try {
    media = (await chrome.tabs.sendMessage(tab.id, { type: 'TL_MEDIA' }))?.src || null;
  } catch {}

  let ws;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    state.sync = { ...state.sync, status: 'error', error };
    flushState();
    tellCard(tab.id, { type: 'TL_PROGRESS', text: error, error: true });
    try {
      ws.close();
    } catch {}
  };
  try {
    ws = new WebSocket(HELPER_URL);
  } catch {
    return fail(HELPER_DOWN);
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'align', url: tab.url, force, media }));
  ws.onerror = () => fail(HELPER_DOWN);
  ws.onclose = () => fail('Lost the connection to the helper.');
  ws.onmessage = async (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.type === 'align_progress') {
      if (state.sync.stage !== d.stage) {
        tellCard(tab.id, { type: 'TL_PROGRESS', text: STAGE_TEXT[d.stage] || 'Working…' });
      }
      state.sync.stage = d.stage;
      state.sync.pct = d.pct;
      broadcastState();
    } else if (d.type === 'align_error') {
      fail(d.error || 'Could not sync this video.');
    } else if (d.type === 'align_result') {
      settled = true;
      const timeline = d.timeline;
      await chrome.storage.session.set({ [`qltTL_${tab.id}`]: { key, timeline } }).catch(() => {});
      state.sync = { ...IDLE_SYNC, status: 'ready', tabId: tab.id, key, pct: 1, summary: summarize(timeline) };
      flushState();
      tellCard(tab.id, { type: 'TL_LOAD', timeline });
      try {
        ws.close();
      } catch {}
    }
  };
}

async function clearSync(tabId) {
  const id = tabId ?? state.sync.tabId;
  if (id != null) {
    await chrome.storage.session.remove(`qltTL_${id}`).catch(() => {});
    tellCard(id, { type: 'TL_CLEAR' });
  }
  state.sync = { ...IDLE_SYNC };
  flushState();
}

// --- Start / stop -----------------------------------------------------------

/**
 * Tear down any existing capture. Critical: the offscreen document holds the
 * tab's MediaStream, and MV3 service workers are ephemeral — so after a SW
 * restart an *orphaned* capture can still be running while our in-memory state
 * says idle. Closing the offscreen document releases the stream, which is what
 * clears Chrome's "Cannot capture a tab with an active stream" error.
 */
async function teardown() {
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
    } catch {}
    await closeOffscreen();
  }
  for (const t of new Set([state.tabId, state.displayTabId])) {
    if (t != null) {
      try {
        await tellCard(t, { type: 'CARD_HIDE' });
      } catch {}
    }
  }
  state.capturing = false;
  state.captureEpoch++;
  state.tabId = null;
  state.displayTabId = null;
  state.status = 'idle';
  state.modelProgress = null;
}

async function startCapture() {
  // Always start from a clean slate — releases any orphaned stream on this or a
  // previous tab so getMediaStreamId can't fail with "active stream".
  await teardown();
  if (state.sync.status !== 'idle') await clearSync(); // one mode at a time

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setError('No active tab to capture.');
    return;
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    setError(
      `Could not start tab capture: ${err?.message || err}. ` +
        'Try reloading the tab, then Start again.',
    );
    return;
  }

  await ensureOffscreen();

  state.capturing = true;
  state.tabId = tab.id;
  state.displayTabId = tab.id;
  state.status = 'loading-model';
  state.error = null;
  state.lastMatch = null;

  const { qltRecognition = 'helper' } = await chrome.storage.local.get('qltRecognition');
  state.backend = qltRecognition;
  state.captureEpoch++;

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    backend: qltRecognition,
  });

  await tellCard(tab.id, { type: 'CARD_SHOW', status: state.status });
  await tellCard(tab.id, { type: 'CARD_WATCH_MEDIA' }); // watch this tab's play/pause
  broadcastState();
  updateBadge();
}

async function stopCapture() {
  await teardown();
  broadcastState();
  updateBadge();
}

function setError(msg) {
  state.error = msg;
  state.status = 'error';
  state.capturing = false;
  broadcastState();
  updateBadge();
}

// --- UI feedback ------------------------------------------------------------
function updateBadge() {
  const on = state.capturing;
  chrome.action.setBadgeText({ text: on ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#1f9d55' : '#000000' });
}

function broadcastState() {
  // Throttle to ~2.5×/s and coalesce bursts (the offscreen emits many DEBUG/
  // RESULT messages), so we don't flood messaging or thrash storage.
  const now = Date.now();
  const gap = now - lastBroadcast;
  if (gap >= 400) {
    lastBroadcast = now;
    flushState();
  } else if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      lastBroadcast = Date.now();
      flushState();
    }, 400 - gap);
  }
}

// --- Message routing --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages we send to the offscreen doc.
  if (msg?.target === 'offscreen') return;

  switch (msg?.type) {
    case 'CAPTURE_CLOCK':
      captureClock().then(sendResponse);
      return true;
    case 'CAPTURE_RESET':
      (async () => {
        const capId = await resolveTabId();
        if (state.capturing && sender?.tab?.id === capId) {
          state.lastMatch = null;
          state.captureEpoch++;
          state.debug = 'Seeking — confirming the new passage…';
          broadcastState();
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESET_CAPTURE' }).catch(() => {});
        }
      })();
      return true;
    case 'TR_GET':
      // Translations in other languages ship inside the extension (public/tr).
      (async () => {
        try {
          trCache[msg.lang] ||= fetch(chrome.runtime.getURL(`tr/${msg.lang}.json`)).then((r) => r.json());
          const all = await trCache[msg.lang];
          sendResponse({ map: Object.fromEntries((msg.refs || []).map((r) => [r, all[r]]).filter((e) => e[1])) });
        } catch {
          delete trCache[msg.lang];
          sendResponse({});
        }
      })();
      return true;

    case 'MEDIA_TOGGLE':
      (async () => {
        const capId = await resolveTabId();
        if (capId != null) tellCard(capId, { type: 'CARD_TOGGLE_MEDIA' });
      })();
      return true;

    case 'FONT_GET':
      (async () => {
        try {
          const buf = await (await fetch(chrome.runtime.getURL(`fonts/${msg.file}`))).arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          sendResponse({ b64: btoa(bin) });
        } catch {
          sendResponse({});
        }
      })();
      return true;

    case 'PING_HELPER':
      pingHelper().then(sendResponse);
      return true;

    case 'SYNC_START':
      startSync(!!msg.force);
      sendResponse?.({ ok: true });
      return true;

    case 'SYNC_CLEAR':
      clearSync(sender?.tab?.id);
      sendResponse?.({ ok: true });
      return true;

    case 'TL_HELLO':
      // A page (re)loaded: give it back the timeline made for this tab + video.
      (async () => {
        const id = sender?.tab?.id;
        const k = `qltTL_${id}`;
        const r = id != null ? await chrome.storage.session.get(k).catch(() => ({})) : {};
        const saved = r[k];
        if (saved && saved.key === videoKey(msg.url || '')) {
          sendResponse({ timeline: saved.timeline });
        } else {
          sendResponse({});
        }
      })();
      return true;

    case 'MEDIA_STATE':
      // Play/pause report from a content script — only act on the captured tab,
      // and forward it to wherever the card currently is.
      (async () => {
        const capId = await resolveTabId();
        if (sender?.tab?.id != null && sender.tab.id === capId) {
          state.mediaPlaying = msg.playing !== false;
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'MEDIA_PLAYING', playing: state.mediaPlaying }).catch(() => {});
          const disp = await resolveDisplayTabId();
          if (disp != null) tellCard(disp, { type: 'CARD_MEDIA', playing: state.mediaPlaying });
          broadcastState();
        }
      })();
      return true;
    case 'GET_STATE':
      // Reconcile with reality: the offscreen document existing is the source of
      // truth for "are we capturing", so the popup self-corrects after a SW
      // restart (shows Stop for an orphaned capture instead of Start).
      (async () => {
        await restored; // ensure persisted state is loaded after a SW respawn
        const live = await hasOffscreen();
        if (!live && state.capturing) {
          state.capturing = false;
          state.status = 'idle';
        } else if (live) {
          state.capturing = true;
        }
        sendResponse({ state });
      })();
      return true;

    case 'START':
      startCapture().catch((error) => {
        setError(error.message || String(error));
        closeOffscreen();
      });
      sendResponse?.({ ok: true });
      return true;

    case 'STOP':
      stopCapture();
      sendResponse?.({ ok: true });
      return true;

    // --- messages coming FROM the offscreen document ---
    case 'STATUS':
      state.status = msg.status;
      if (msg.status === 'stopped') state.capturing = false;
      broadcastState();
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null) tellCard(tabId, { type: 'CARD_STATUS', status: msg.status });
      })();
      return true;

    case 'MODEL_PROGRESS':
      state.modelProgress = msg.progress;
      broadcastState();
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null)
          tellCard(tabId, { type: 'CARD_STATUS', status: 'loading-model', progress: msg.progress });
      })();
      return true;

    case 'RESULT':
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (msg.match) {
          if (msg.clock && msg.clock.captureEpoch !== state.captureEpoch) return;
          if (msg.clock && (!state.capturing || msg.clock.captureEpoch !== state.captureEpoch)) return;
          state.lastMatch = msg.match;
          if (tabId != null) tellCard(tabId, { type: 'CARD_UPDATE', match: msg.match });
        } else if (tabId != null) {
          tellCard(tabId, { type: 'CARD_STATUS', status: 'listening' });
        }
        broadcastState();
      })();
      return true;

    case 'DEBUG':
      state.debug = msg.text;
      broadcastState();
      return true;

    case 'ERROR':
      setError(msg.error);
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null)
          tellCard(tabId, { type: 'CARD_STATUS', status: 'error', error: msg.error });
        await closeOffscreen(); // Do not report a stopped recognizer as an orphaned active capture.
      })();
      return true;
  }
});

// --- Card follows the active tab -------------------------------------------
async function moveCardTo(tabId) {
  if (!state.capturing || tabId == null || tabId === state.displayTabId) return;
  const prev = state.displayTabId;
  state.displayTabId = tabId;
  // Draw the card on the newly-active tab with the latest known verse/status.
  await tellCard(tabId, { type: 'CARD_SHOW', status: state.status });
  if (state.lastMatch) await tellCard(tabId, { type: 'CARD_UPDATE', match: state.lastMatch });
  else await tellCard(tabId, { type: 'CARD_STATUS', status: state.status });
  await tellCard(tabId, { type: 'CARD_MEDIA', playing: state.mediaPlaying }); // keep pause state
  if (prev != null && prev !== tabId) await tellCard(prev, { type: 'CARD_HIDE' });
  flushState();
}

chrome.tabs.onActivated.addListener(async (info) => {
  await restored;
  moveCardTo(info.tabId);
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  await restored;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
    if (tab?.id != null) moveCardTo(tab.id);
  } catch {}
});
// If the captured tab closes, stop cleanly.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.capturing && tabId === state.tabId) stopCapture();
  chrome.storage.session.remove(`qltTL_${tabId}`).catch(() => {});
  if (state.sync.tabId === tabId) {
    state.sync = { ...IDLE_SYNC };
    flushState();
  }
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
