import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AudioWindow } from '../src/offscreen/audio-window.js';
import { RecognitionScheduler } from '../src/offscreen/recognition-scheduler.js';
import { recognitionCooldown } from '../src/offscreen/live-pacing.js';

assert.equal(recognitionCooldown(500), 2000);
assert.equal(recognitionCooldown(6000), 3000);
assert.equal(recognitionCooldown(30000), 5000);
let now = 0;
let tick;
const submitted = [];
const messages = [];
const timers = new Map();
let timerId = 0;
const context = vm.createContext({ AudioWindow, RecognitionScheduler, recognitionCooldown,
  Float32Array, performance: { now: () => now }, console,
  Worker: class { postMessage(m) { submitted.push(m); } terminate() {} },
  WebSocket: class { static OPEN = 1; constructor() { throw new Error('CPU live must not open a helper socket'); } },
  setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  chrome: { runtime: { getURL: () => 'chrome-extension://test/', onMessage: { addListener() {} },
    async sendMessage(m) {
      messages.push(m);
      if (m.type === 'CAPTURE_CLOCK') return { key: 'video', duration: 1200, time: 8, paused: false, captureEpoch: 1 };
    } } },
});
const code = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/new URL\([^\n]*import\.meta\.url\)/g, "'worker.js'");
vm.runInContext(code, context);
vm.runInContext(`
  running = true; backend = 'browser'; connectBrowser();
  recognitionWorker.onmessage({ data: { type: 'ready', threads: 1 } });
  const frame = new Float32Array(6 * 16000).fill(0.1);
  windowAudio.push(frame); scheduler.push(frame);
`, context);
tick();
await new Promise((r) => setImmediate(r));
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1);
tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1, 'busy inference never queues another call');
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation,
  ms: 6000, match: { ref: '1:2' }, tracking: { locked: true } } });
  scheduler.push(new Float32Array(8 * 16000).fill(0.1));`, context);
assert.ok(messages.some((m) => m.type === 'RESULT' && m.match.ref === '1:2'));
now = 2999; tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1, 'slower CPUs get idle time between calls');
now = 3001; tick();
await new Promise((r) => setImmediate(r));
assert.equal(submitted.filter((m) => m.type === 'audio').length, 2);
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation, ms: 1000 } });
  mediaPlaying = false; scheduler.push(new Float32Array(8 * 16000).fill(0.1));`, context);
now = 10000; tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, 2, 'paused media submits no inference');
assert.ok(submitted.every((m) => ['init', 'audio', 'reset'].includes(m.type)), 'no scan jobs exist');
assert.ok(!messages.some((m) => /SCAN|DOWNLOAD|ALIGN/.test(m.type)), 'no timeline jobs or helper requests');
vm.runInContext('stopCapture()', context);
console.log('CPU live-only capture, no helper, bounded inference, adaptive cooldown and pause checks passed.');
