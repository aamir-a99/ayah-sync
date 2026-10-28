import assert from 'node:assert/strict';
import { LookaheadBuffer, alignTimedWords } from '../src/cpu/lookahead-buffer.js';

const a = { ref: '1:2', arabic: 'الحمد لله رب العالمين', wordCount: 4 };
const b = { ref: '1:3', arabic: 'الرحمن الرحيم', wordCount: 2 };
const words = [{ text: 'الحمد', start: 0.1, end: 0.5 }, { text: 'لله', start: 0.6, end: 0.9 },
  { text: 'رب', start: 1, end: 1.2 }, { text: 'العالمين', start: 1.3, end: 2 }];
assert.deepEqual(alignTimedWords(words, a).map((w) => w.word), [0, 1, 2, 3]);
const buffer = new LookaheadBuffer();
buffer.add(5, 4, { timedWords: words }, 6);
assert.equal(buffer.cues.length, 0, 'timed words alone cannot invent an unconfirmed verse');
buffer.add(6, 4, { timedWords: [], timingMatch: a }, 6);
assert.equal(buffer.cues[0].t0, 5.1, 'confirmed verses can reuse acoustic evidence from preceding windows');
buffer.add(10, 4, { timingMatch: b, timedWords: [
  { text: 'الرحمن', start: 0.5, end: 0.9 }, { text: 'الرحيم', start: 1, end: 1.4 },
] }, 6);
assert.equal(buffer.cues[1].t0, 10.5);
assert.equal(buffer.cues.findLast((c) => c.t0 <= 9).match.ref, '1:2', 'future recognition must not switch the current playhead early');
assert.equal(buffer.cues.findLast((c) => c.t0 <= 10.5).match.ref, '1:3');
for (let i = 0; i < 100; i++) buffer.add(11 + i, 4, { timedWords: [], timingMatch: b }, 11 + i);
assert.ok(buffer.history.length <= 9, 'retained raw transcript windows are bounded');
buffer.reset();
assert.equal(buffer.cues.length, 0);
assert.equal(buffer.from, null);
console.log('CPU look-ahead acoustic timing, no-early-switch, seek reset and bounded-history checks passed.');
