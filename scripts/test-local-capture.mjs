// Exercise the real tab-capture → worklet → CPU worker → card path in Brave.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const extensionId = [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const audioPath = resolve(root, 'server/cache/gt_7_1.mp3');
if (!existsSync(audioPath)) {
  const response = await fetch('https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/1.mp3');
  if (!response.ok) throw new Error(`Test audio download failed: ${response.status}`);
  await mkdir(resolve(root, 'server/cache'), { recursive: true });
  await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
}
const audio = readFileSync(audioPath);
const server = createServer((req, res) => {
  if (req.url === '/audio.mp3') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${audio.length}` });
      res.end(audio.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Accept-Ranges': 'bytes' });
      res.end(audio);
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Local recitation capture test</title><button id="play">Play recitation</button><video controls src="/audio.mp3"></video><script>document.querySelector("button").onclick=()=>document.querySelector("video").play()</script>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/google-chrome', headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  // Chromium's test-only allowlist substitutes for clicking the browser toolbar
  // in headless mode. Production users still explicitly invoke the extension.
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
    `--allowlisted-extension-id=${extensionId}`, '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run'], protocolTimeout: 120000 });
try {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const origin = `chrome-extension://${new URL(target.url()).host}`;
  if (new URL(target.url()).host !== extensionId) throw new Error('Unexpected unpacked extension ID');
  const observer = await browser.newPage();
  observer.on('console', (m) => console.log(m.text()));
  await observer.goto(`${origin}/src/popup/popup.html`);
  await observer.waitForSelector('#recognition');
  if (await observer.$('#cpuBackground')) throw new Error('Timeline must not have an on/off setting');
  if ((await observer.$eval('#recognition', (el) => el.value)) !== 'helper') {
    throw new Error('Existing helper mode must remain the default');
  }
  if (!(await observer.$eval('#cpuHighlightSetting', (el) => el.hidden))) {
    throw new Error('CPU highlighting setting must be hidden in helper mode');
  }
  // Exercise both popup actions without starting capture from this observer
  // tab. Headless tests do not get toolbar-granted activeTab URL metadata.
  await observer.evaluate(() => {
    window.originalSendMessage = chrome.runtime.sendMessage;
    window.syncActions = [];
    chrome.runtime.sendMessage = (message, ...args) => {
      if (['SYNC_START', 'START'].includes(message.type)) {
        window.syncActions.push(message.type);
        return Promise.resolve({ ok: true });
      }
      return window.originalSendMessage(message, ...args);
    };
    const button = document.querySelector('#syncBtn');
    button.disabled = false;
    button.click();
  });
  await observer.select('#recognition', 'browser');
  await observer.waitForFunction(() => !document.querySelector('#cpuHighlightSetting').hidden);
  if (!(await observer.$eval('#cpuHighlight', (el) => el.checked))) {
    throw new Error('CPU word highlighting must default to on');
  }
  await observer.evaluate(() => {
    const button = document.querySelector('#syncBtn');
    button.disabled = false;
    button.click();
    chrome.runtime.sendMessage = window.originalSendMessage;
  });
  const actions = await observer.evaluate(() => window.syncActions);
  if (actions.join(',') !== 'SYNC_START,START') throw new Error(`Unexpected sync actions: ${actions}`);
  console.log('Shared Sync action: helper default and CPU opt-in passed.');
  await observer.evaluate(() => {
    let last;
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'STATE' && (m.state.debug || m.state.error) !== last) {
        last = m.state.debug || m.state.error;
        console.log('Capture state:', JSON.stringify({ status: m.state.status,
          playing: m.state.mediaPlaying, ref: m.state.lastMatch?.ref, debug: last }));
      }
    });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.click('#play');
  console.log('Media:', await page.evaluate(() => {
    const v = document.querySelector('video');
    return { paused: v.paused, time: v.currentTime, duration: v.duration, error: v.error?.message };
  }));
  await page.bringToFront();
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
  await page.waitForFunction(() => {
    const root = document.querySelector('#__qlt_card_host__')?.shadowRoot;
    return root && !root.querySelector('#ribbon').classList.contains('hidden');
  }, { timeout: 5000 });
  const initialRibbon = await page.evaluate(() => {
    const root = document.querySelector('#__qlt_card_host__').shadowRoot;
    return { label: !root.querySelector('#ribbonLabel').classList.contains('hidden'),
      navigationDisabled: root.querySelector('#again').disabled };
  });
  if (!initialRibbon.label || !initialRibbon.navigationDisabled) throw new Error('Empty CPU timeline must be visible before recognition');
  console.log('CPU timeline visible before the first recognition result.');
  await observer.waitForFunction(async () => {
    const { qltState } = await chrome.storage.session.get('qltState');
    if (qltState?.error) throw new Error(qltState.error);
    return !!qltState?.lastMatch;
  }, { timeout: 60000, polling: 500 }).catch(async (e) => {
    console.log('Final state:', await observer.evaluate(() => chrome.storage.session.get('qltState')));
    throw e;
  });
  const state = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState);
  console.log(JSON.stringify({ status: state.status, ref: state.lastMatch?.ref,
    debug: state.debug, translation: state.lastMatch?.translation }, null, 2));
  const card = await page.evaluate(() => {
    const shadow = document.querySelector('#__qlt_card_host__')?.shadowRoot;
    return { arabic: shadow?.querySelector('#arabic')?.textContent,
      translation: shadow?.querySelector('#trans')?.textContent,
      highlightedWords: shadow?.querySelectorAll('.w.cur').length };
  });
  console.log('Card:', card);
  if (!card.translation) throw new Error('Translation card did not render');
  if (card.highlightedWords !== 0) throw new Error('Recognition-only mode unexpectedly highlighted a word');
  await observer.$eval('#cpuHighlight', (el) => el.click());
  await observer.waitForFunction(async () => (await chrome.storage.local.get('qltCPUHighlight')).qltCPUHighlight === false);
  await observer.reload();
  await observer.waitForFunction(() => document.querySelector('#recognition').value === 'browser' &&
    !document.querySelector('#cpuHighlight').checked);
  await observer.$eval('#cpuHighlight', (el) => el.click());
  await observer.waitForFunction(async () => (await chrome.storage.local.get('qltCPUHighlight')).qltCPUHighlight === true);
  const preparing = await page.evaluate(() => {
    const root = document.querySelector('#__qlt_card_host__').shadowRoot;
    return { current: root.querySelectorAll('.w.cur').length, note: root.querySelector('#cpuSyncNote').textContent };
  });
  if (preparing.current || !/Waiting for the helper|Fetching the audio|Sync unavailable/.test(preparing.note)) throw new Error('Highlighting must wait for fetched audio');
  await observer.reload();
  await observer.waitForFunction(() => document.querySelector('#cpuHighlight').checked);
  await observer.$eval('#cpuHighlight', (el) => el.click());
  await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot
    ?.querySelectorAll('.w.cur').length === 0, { timeout: 5000 });
  console.log('CPU highlight preference persists, but stays inactive until audio is fetched.');
  // Both backends must render the same working and ready stages, even while
  // browser CPU capture is still running in the background.
  const worker = await target.worker();
  for (const [stage, text] of [['download', 'Fetching the audio…'],
    ['transcribe', 'Recognising the recitation…'], ['align', 'Timing every word…']]) {
    await worker.evaluate(async ({ stage, id }) => {
      const { qltState } = await chrome.storage.session.get('qltState');
      await chrome.runtime.sendMessage({ type: 'STATE', state: { ...qltState,
        sync: { status: 'working', tabId: id, stage, pct: 0.5 } } });
    }, { stage, id: state.tabId });
    await observer.waitForFunction((text) => !document.querySelector('#stageWorking').hidden &&
      document.querySelector('#workStage').textContent === text, { timeout: 5000 }, text);
  }
  await worker.evaluate(async (id) => {
    const { qltState } = await chrome.storage.session.get('qltState');
    await chrome.runtime.sendMessage({ type: 'STATE', state: { ...qltState,
      sync: { status: 'ready', tabId: id, summary: { ayahs: 1, passages: [], names: {} } } } });
  }, state.tabId);
  await observer.waitForFunction(() => !document.querySelector('#stageReady').hidden, { timeout: 5000 });
  await worker.evaluate(async () => {
    const { qltState } = await chrome.storage.session.get('qltState');
    await chrome.runtime.sendMessage({ type: 'STATE', state: qltState });
  });
  console.log('CPU mode uses the shared sync progress and ready UI.');
  const firstLearned = await observer.evaluate(async (id) =>
    (await chrome.storage.session.get(`qltLearned_${id}`))[`qltLearned_${id}`], state.tabId);
  if (!firstLearned?.partial || !firstLearned.entries.length) throw new Error('Background timeline did not learn a marker');
  const firstTime = firstLearned.entries[0].t0;
  const currentTime = await page.evaluate(() => document.querySelector('video').currentTime);
  if (firstTime >= currentTime - 0.2) throw new Error('Marker appears to use inference-completion time');
  const timelineUI = await page.evaluate(() => {
    const root = document.querySelector('#__qlt_card_host__').shadowRoot;
    return { visible: !root.querySelector('#ribbon').classList.contains('hidden'),
      markers: root.querySelectorAll('#spans .tick').length,
      mode: root.querySelector('#ribbon').dataset.mode,
      unlearnedFillHidden: getComputedStyle(root.querySelector('#fill')).display === 'none' };
  });
  if (!timelineUI.visible || !timelineUI.markers) throw new Error('CPU timeline ribbon is missing');
  if (timelineUI.mode !== 'learned' || !timelineUI.unlearnedFillHidden) throw new Error('Partial ribbon implies unlearned coverage');
  console.log('Learned timeline:', { firstTime, currentTime, ...timelineUI });
  const beforeSeekEpoch = state.captureEpoch;
  await page.evaluate(() => document.querySelector('video').pause());
  await observer.waitForFunction(async () => {
    const { qltState } = await chrome.storage.session.get('qltState');
    return qltState?.mediaPlaying === false;
  }, { timeout: 10000, polling: 250 });
  await page.evaluate(async () => {
    const v = document.querySelector('video');
    await new Promise((resolve) => {
      v.addEventListener('seeked', resolve, { once: true });
      v.currentTime = 30;
    });
    await v.play();
  });
  if ((await page.evaluate(() => document.querySelector('video').currentTime)) < 29) {
    throw new Error('Test media did not seek to the expected time');
  }
  await observer.waitForFunction(async (epoch) => {
    const { qltState } = await chrome.storage.session.get('qltState');
    if (qltState?.error) throw new Error(qltState.error);
    return qltState?.captureEpoch > epoch && ['1:6', '1:7'].includes(qltState?.lastMatch?.ref);
  }, { timeout: 45000, polling: 250 }, beforeSeekEpoch);
  console.log('Pause/seek/resume:', await observer.evaluate(async () =>
    (await chrome.storage.session.get('qltState')).qltState.lastMatch.ref));
  await page.evaluate(() => document.querySelector('video').pause());
  const saved = await observer.evaluate(async (id) => {
    const key = `qltLearned_${id}`;
    const deadline = Date.now() + 8000;
    for (;;) {
      const value = (await chrome.storage.session.get(key))[key];
      if ((value?.entries.length || 0) >= 2 || Date.now() > deadline) return value;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, state.tabId);
  if (!saved?.entries || saved.entries.length < 2) throw new Error('Seek did not add a learned marker');
  if (saved.entries.some((e) => e.t0 < 30 && e.t1 >= 30)) {
    throw new Error('Seek gap was incorrectly marked as learned');
  }
  const lastMarker = saved.entries.at(-1).t0;
  await page.evaluate(() => document.querySelector('#__qlt_card_host__').shadowRoot.querySelector('#again').click());
  await page.waitForFunction((at) => Math.abs(document.querySelector('video').currentTime - at) < 0.3,
    { timeout: 10000 }, lastMarker);
  console.log('Repeat learned ayah seeks to:', lastMarker);
  const point = await page.evaluate((at) => {
    const ribbon = document.querySelector('#__qlt_card_host__').shadowRoot.querySelector('#ribbon');
    const rect = ribbon.getBoundingClientRect();
    return { x: rect.left + at / document.querySelector('video').duration * rect.width,
      y: rect.top + rect.height / 2 };
  }, firstTime);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((at) => Math.abs(document.querySelector('video').currentTime - at) < 0.3,
    { timeout: 10000 }, firstTime);
  console.log('Ribbon click seeks to earlier learned marker:', firstTime);
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  await observer.waitForFunction(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length === 0,
  { timeout: 10000, polling: 250 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot
    ?.querySelectorAll('#spans .tick').length >= 2, { timeout: 10000 });
  console.log('CPU background learning, partial ribbon, repeat navigation, seek gaps and reload restore passed.');
} finally {
  await browser.close();
  server.close();
}
