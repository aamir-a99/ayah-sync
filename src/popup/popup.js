/** Popup: start a sync (or live listening) for this tab, and reading settings. */

const $ = (id) => document.getElementById(id);
const stages = {
  idle: $('stageIdle'),
  working: $('stageWorking'),
  ready: $('stageReady'),
  live: $('stageLive'),
  helper: $('stageHelper'),
};

const STAGE_TEXT = {
  queued: 'Waiting for the helper…',
  download: 'Fetching the audio…',
  transcribe: 'Recognising the recitation…',
  align: 'Timing every word…',
};
// How much of the bar each stage owns.
const STAGE_SPAN = { queued: [0, 0.03], download: [0.03, 0.15], transcribe: [0.15, 0.85], align: [0.85, 1] };

const PREVIEW = {
  uthmani: ['بِسْمِ', 'ٱللَّهِ', 'ٱلرَّحْمَٰنِ', 'ٱلرَّحِيمِ'],
  indopak: ['بِسۡمِ', 'اللّٰهِ', 'الرَّحۡمٰنِ', 'الرَّحِيۡمِ'],
};
const MIN_SIZE = 16;
const MAX_SIZE = 44;

let tab = null;
let helper = null; // null = unknown, else {ok, model, device}
let state = null;
let curScript = 'uthmani';
let curSize = 24;

// ------------------------------------------------------------------- fonts
(function fonts() {
  const url = (f) => chrome.runtime.getURL(`fonts/${f}`);
  const style = document.createElement('style');
  style.textContent =
    `@font-face{font-family:'QLT-Uthmani';src:url('${url('uthmani.woff2')}') format('woff2');}` +
    `@font-face{font-family:'QLT-IndoPak';src:url('${url('indopak.woff2')}') format('woff2');}` +
    `@font-face{font-family:'QLT-Text';src:url('${url('figtree.woff2')}') format('woff2');font-weight:400 700;}`;
  document.head.appendChild(style);
})();

// ------------------------------------------------------------------ render
function clock(t) {
  t = Math.max(0, Math.round(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function passageLabel(p, names) {
  const [s1, a1] = p.from.split(':');
  const [s2, a2] = p.to.split(':');
  const n1 = names[s1] || `Surah ${s1}`;
  if (s1 === s2) return { name: n1, ref: a1 === a2 ? `${s1}:${a1}` : `${s1}:${a1}–${a2}` };
  return { name: `${n1} – ${names[s2] || `Surah ${s2}`}`, ref: `${p.from}–${p.to}` };
}

function show(which) {
  for (const [k, el] of Object.entries(stages)) el.hidden = k !== which;
}

function render() {
  // Helper status (top right)
  const h = $('helper');
  h.className = `helper ${helper == null ? '' : helper.ok ? 'on' : 'off'}`;
  $('helperText').textContent = helper == null ? 'Checking…' : helper.ok ? 'Helper on' : 'Helper off';
  h.title = helper?.ok ? `${helper.model || ''} · ${helper.device === 'cuda' ? 'GPU' : 'CPU'}` : '';

  if (!state) return;
  const sync = state.sync || { status: 'idle' };
  const mine = tab && sync.tabId === tab.id;
  const title = tab?.title?.replace(/ - YouTube$/, '') || 'This page';
  const problem = $('problem');
  problem.hidden = true;

  if (state.capturing) {
    show('live');
    const m = state.lastMatch;
    $('liveRef').textContent = m
      ? `${m.surahMeta?.englishName || `Surah ${m.surah}`} ${m.surah}:${m.ayah}`
      : 'Waiting for recitation…';
    if (state.error) {
      problem.hidden = false;
      problem.textContent = state.error;
    }
    return;
  }
  if (helper && !helper.ok && !(mine && sync.status === 'ready')) {
    show('helper');
    return;
  }
  if (mine && sync.status === 'working') {
    show('working');
    $('workTitle').textContent = title;
    $('workStage').textContent = STAGE_TEXT[sync.stage] || 'Working…';
    const [a, b] = STAGE_SPAN[sync.stage] || [0, 0];
    const pct = Math.round((a + (b - a) * (sync.pct || 0)) * 100);
    $('meterFill').style.width = `${pct}%`;
    $('meter').setAttribute('aria-valuenow', String(pct));
    return;
  }
  if (mine && sync.status === 'ready' && sync.summary) {
    show('ready');
    const s = sync.summary;
    const list = $('passages');
    list.textContent = '';
    for (const p of s.passages) {
      const { name, ref } = passageLabel(p, s.names || {});
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = name;
      const right = document.createElement('span');
      right.innerHTML = `<span class="ref"></span><span class="at"></span>`;
      right.firstChild.textContent = ref;
      right.lastChild.textContent = clock(p.t0);
      li.append(left, right);
      list.append(li);
    }
    $('readyNote').textContent =
      `${s.ayahs} ayah${s.ayahs === 1 ? '' : 's'}, every word timed. The card on the page follows the video.`;
    return;
  }

  show('idle');
  $('tabTitle').textContent = title;
  const usable = !!tab && /^https?:/.test(tab.url || '');
  $('syncBtn').disabled = !usable;
  $('liveBtn').hidden = !usable;
  const err = (mine && sync.status === 'error' && sync.error) || state.error || (!usable && 'Open a page with a video to begin.');
  if (err) {
    problem.hidden = false;
    problem.textContent = err;
  }
}

function paintReading() {
  for (const b of $('scriptSeg').querySelectorAll('button')) {
    const on = b.dataset.v === curScript;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // The preview shows the card's own highlight: recited, current, upcoming.
  const p = $('preview');
  p.classList.toggle('indopak', curScript === 'indopak');
  p.style.fontSize = `${Math.min(curSize, 30)}px`;
  p.textContent = '';
  PREVIEW[curScript].forEach((w, i) => {
    const s = document.createElement('span');
    s.textContent = w;
    if (i === 2) s.className = 'cur';
    if (i === 3) s.className = 'todo';
    p.append(s, ' ');
  });
  $('sizeVal').textContent = String(curSize);
}

// -------------------------------------------------------------------- data
async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res?.state) state = res.state;
  } catch {}
  render();
}

async function checkHelper() {
  try {
    helper = (await chrome.runtime.sendMessage({ type: 'PING_HELPER' })) || { ok: false };
  } catch {
    helper = { ok: false };
  }
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATE') {
    state = msg.state;
    render();
  }
});

// ----------------------------------------------------------------- actions
const send = (type, extra) => chrome.runtime.sendMessage({ type, ...extra }).then(() => setTimeout(refresh, 120));
$('syncBtn').addEventListener('click', () => send('SYNC_START'));
$('resyncBtn').addEventListener('click', () => send('SYNC_START', { force: true }));
$('clearBtn').addEventListener('click', () => send('SYNC_CLEAR'));
$('liveBtn').addEventListener('click', () => send('START'));
$('stopBtn').addEventListener('click', () => send('STOP'));
$('retryBtn').addEventListener('click', () => {
  helper = null;
  render();
  checkHelper();
});

// ---------------------------------------------------------------- settings
chrome.storage.local.get(['showTranslation', 'qltScript', 'qltFontSize', 'qltAmbient', 'qltLang'], (v) => {
  $('ambient').checked = v?.qltAmbient !== false;
  $('lang').value = v?.qltLang || 'en';
  $('showTrans').checked = v?.showTranslation !== false;
  curScript = v?.qltScript || 'uthmani';
  curSize = v?.qltFontSize || 24;
  paintReading();
});
$('showTrans').addEventListener('change', (e) => chrome.storage.local.set({ showTranslation: e.target.checked }));
$('lang').addEventListener('change', (e) => chrome.storage.local.set({ qltLang: e.target.value }));
$('ambient').addEventListener('change', (e) => chrome.storage.local.set({ qltAmbient: e.target.checked }));
$('scriptSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  curScript = b.dataset.v;
  chrome.storage.local.set({ qltScript: curScript });
  paintReading();
});
const resize = (d) => {
  curSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, curSize + d));
  chrome.storage.local.set({ qltFontSize: curSize });
  paintReading();
};
$('sizeDown').addEventListener('click', () => resize(-2));
$('sizeUp').addEventListener('click', () => resize(2));

// -------------------------------------------------------------------- boot
(async () => {
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  // Paint from the last saved state at once; the worker may be waking up.
  try {
    const r = await chrome.storage.session.get('qltState');
    if (r?.qltState) state = r.qltState;
  } catch {}
  state ||= { capturing: false, sync: { status: 'idle' } };
  render();
  refresh();
  checkHelper();
})();
