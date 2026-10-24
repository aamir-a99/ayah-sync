import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LearnedTimeline } from '../src/timeline/learned.js';

const messages = [];
const sockets = [];
const stored = {};
const event = { addListener() {} };
const storage = {
  async get(key) { return { [key]: stored[key] }; },
  async set(value) { Object.assign(stored, value); },
  async remove(key) { delete stored[key]; },
};
class Socket {
  constructor(url) { this.url = url; sockets.push(this); }
  send(value) { this.sent = JSON.parse(value); }
  close() { this.closed = true; this.onclose?.(); }
}
const context = vm.createContext({
  LearnedTimeline, WebSocket: Socket, URL, crypto: { randomUUID: () => String(sockets.length) },
  Date, console, setTimeout: () => 1, clearTimeout() {},
  chrome: {
    storage: { session: storage, local: storage },
    tabs: { async sendMessage(id, message) {
      messages.push({ id, ...message });
      return message.type === 'TL_MEDIA' ? { src: 'https://example.test/audio.mp3' } : null;
    }, onActivated: event, onRemoved: event },
    windows: { onFocusChanged: event },
    runtime: { onMessage: event, onInstalled: event, onStartup: event,
      async sendMessage() {}, async getContexts() { return []; } },
  },
});
const code = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');
vm.runInContext(code, context);
await vm.runInContext('restored', context);
await vm.runInContext(`
  state.capturing = true; state.backend = 'browser'; state.tabId = 7; state.displayTabId = 7;
  startSync(false, { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' });
`, context);
const socket = sockets.at(-1);
socket.onopen();
assert.equal(socket.sent.type, 'align');
assert.equal(socket.sent.url, 'https://www.youtube.com/watch?v=abcdefghijk');
assert.equal(socket.sent.media, 'https://example.test/audio.mp3');
assert.equal(vm.runInContext('state.capturing', context), true);
assert.equal(messages.some((m) => m.type === 'TL_PROGRESS'), false, 'Background progress must not hide live verses');
await socket.onmessage({ data: JSON.stringify({ type: 'align_progress', stage: 'transcribe', pct: 0.5 }) });
assert.equal(vm.runInContext('state.background.audioReady', context), true);
const timeline = { duration: 46, ayahs: [{ ref: '1:2', surah: 1, t0: 5, t1: 12, w: [] }] };
await socket.onmessage({ data: JSON.stringify({ type: 'align_result', timeline }) });
assert.equal(vm.runInContext('state.background.stage', context), 'complete');
assert.equal(vm.runInContext('state.capturing', context), true);
assert.ok(messages.some((m) => m.type === 'TL_LOAD'));
assert.ok(stored.qltTL_7);

await vm.runInContext("startSync(false, { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' })", context);
const failed = sockets.at(-1);
failed.onerror();
assert.equal(vm.runInContext('state.background.stage', context), 'unavailable');
assert.equal(vm.runInContext('state.capturing', context), true, 'Missing helper must not stop local CPU recognition');
await vm.runInContext("startSync(false, { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' })", context);
const stale = sockets.at(-1);
vm.runInContext('state.background = null; state.capturing = false;', context);
const count = messages.filter((m) => m.type === 'TL_LOAD').length;
await stale.onmessage({ data: JSON.stringify({ type: 'align_result', timeline }) });
assert.equal(messages.filter((m) => m.type === 'TL_LOAD').length, count, 'Stopped jobs must not load stale timelines');
console.log('Helper background sync: align request, live preservation, timeline handoff, failure and stale-job checks passed.');
