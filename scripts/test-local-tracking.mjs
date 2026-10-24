import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher } from '../src/matcher/match.js';
import { PassageTracker } from '../src/matcher/passage-tracker.js';
import { RecognitionScheduler } from '../src/offscreen/recognition-scheduler.js';
import { AudioWindow } from '../src/offscreen/audio-window.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani');
const matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
const tracker = new PassageTracker(matcher);
assert.equal(tracker.update(ar['2:255']), null, 'first global match remains tentative');
assert.equal(tracker.state().phase, 'confirming');
assert.equal(tracker.update(ar['2:255']).ref, '2:255');
assert.equal(tracker.state().nextRef, '2:256');
tracker.reset(true);
assert.equal(tracker.state().locked, true, 'pause/resume preserves passage');
assert.equal(tracker.update(ar['2:255']).ref, '2:255');
tracker.reset();
assert.equal(tracker.state().locked, false, 'seek discards passage');
assert.equal(tracker.update(ar['1:1']), null);
assert.equal(tracker.update(ar['1:1']), null, 'repeated basmala alone cannot identify the surah');
assert.equal(tracker.update('unrelated speech'), null, 'one noisy window preserves tentative context');
assert.equal(tracker.update(ar['1:2']).ref, '1:2', 'two ambiguous phrases uniquely identify their sequence');
tracker.reset();
assert.equal(tracker.update(ar['1:1']), null);
assert.equal(tracker.update(`${ar['1:1']} ${ar['1:2']}`).ref, '1:2');
assert.equal(tracker.update(ar['1:3']).ref, '1:3', 'expected two-word ayah uses local context');
assert.equal(tracker.state().nextRef, '1:4');
assert.equal(tracker.update('unrelated speech'), null);
assert.equal(tracker.update('unrelated speech'), null);
assert.equal(tracker.state().locked, false, 'lost confidence returns to global identification');
tracker.reset();
assert.equal(tracker.update(ar['2:255']), null);
assert.equal(tracker.update(ar['67:1']), null, 'unrelated candidates are not confirmation');
assert.equal(tracker.state().locked, false);

const switching = new PassageTracker(matcher);
switching.update(ar['67:1']); switching.update(ar['67:1']);
const nextWords = ar['67:2'].trim().split(/\s+/);
assert.equal(switching.update(`${ar['67:1']} ${nextWords[0]}`), null,
  'one token of the next ayah must not borrow confidence from the preceding ayah');
assert.equal(switching.state().ref, '67:1');
assert.equal(switching.update(`${ar['67:1']} ${nextWords.slice(0, 3).join(' ')}`).ref, '67:2',
  'a supported phrase confirms the next ayah');

const evidence = matcher.match('إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْرٌ',
  matcher.match(ar['1:4']).pos, { localOnly: true, evidenceOnly: true,
    nearbyRefs: new Set(['1:4', '1:5', '1:6']) });
assert.notEqual(evidence?.ref, '1:6', 'hallucinated trailing words do not imply an unheard next ayah');

const sr = 1000;
const voiced = new Float32Array(100).fill(0.1);
const quiet = new Float32Array(100);
const pushSeconds = (scheduler, frame, seconds) => {
  for (let i = 0; i < seconds * 10; i++) scheduler.push(frame);
};
const scheduler = new RecognitionScheduler(sr);
pushSeconds(scheduler, voiced, 5);
assert.equal(scheduler.due(), null, 'spend more time on first identification');
pushSeconds(scheduler, voiced, 1);
assert.equal(scheduler.due(), 'confirm-passage');
scheduler.submittedNow();
pushSeconds(scheduler, voiced, 1);
assert.equal(scheduler.due(), null);
pushSeconds(scheduler, voiced, 1);
assert.equal(scheduler.due(), 'confirm-passage');
scheduler.submittedNow();
scheduler.update({ locked: true, nearEnd: false });
pushSeconds(scheduler, voiced, 2);
assert.equal(scheduler.due(), null, 'avoid redundant continuous polling');
pushSeconds(scheduler, voiced, 1);
pushSeconds(scheduler, quiet, 0.4);
assert.equal(scheduler.due(), 'speech-pause');
assert.ok(scheduler.pauseTail() >= 0.24 * sr && scheduler.pauseTail() <= 0.26 * sr,
  'pause recognition trims silence but preserves a short speech tail');
scheduler.submittedNow();
pushSeconds(scheduler, quiet, 10);
assert.equal(scheduler.due(), null, 'long silence does not repeatedly run ASR');
scheduler.reset(true);
pushSeconds(scheduler, voiced, 4);
assert.equal(scheduler.due(), null, 'continuous speech without a boundary is not polled every four seconds');
pushSeconds(scheduler, voiced, 4);
assert.equal(scheduler.due(), 'tracking-fallback', 'no clear pause still makes progress');
assert.equal(scheduler.windowSamples('tracking-fallback'), 6 * sr);
scheduler.submittedNow();
pushSeconds(scheduler, quiet, 0.5);
pushSeconds(scheduler, voiced, 2.4);
assert.equal(scheduler.due(), 'phrase-start', 'fresh speech after a pause targets a possible new ayah');
assert.ok(scheduler.windowSamples('phrase-start') >= 2.5 * sr && scheduler.windowSamples('phrase-start') < 3 * sr,
  'recognise the new phrase with a short pre-roll, not the previous ayah');
scheduler.submittedNow();
pushSeconds(scheduler, voiced, 0.6);
pushSeconds(scheduler, quiet, 0.5);
assert.equal(scheduler.due(), null, 'do not re-run ASR on a phrase that just got recognised');
pushSeconds(scheduler, voiced, 2.4);
assert.equal(scheduler.due(), 'phrase-start', 'a second breath opens another speech segment');
scheduler.submittedNow();
pushSeconds(scheduler, quiet, 12);
assert.equal(scheduler.due(), null, 'a pause alone never creates a recognition job');
scheduler.reset();
assert.equal(scheduler.phrase, 0, 'seek resets old pause context');
assert.equal(scheduler.windowSamples('confirm-passage'), 10 * sr);
scheduler.reset();
pushSeconds(scheduler, quiet, 20);
assert.equal(scheduler.due(), null, 'silence never acquires or advances a verse');
const steady = new RecognitionScheduler(sr);
steady.update({ locked: true, nearEnd: false });
let steadyCalls = 0;
for (let i = 0; i < 600; i++) {
  steady.push(voiced);
  if (steady.due()) { steadyCalls++; steady.submittedNow(); }
}
assert.equal(steadyCalls, 7, 'continuous mid-ayah speech runs seven checks/minute, not fifteen');
const audio = new AudioWindow(10);
audio.push(Float32Array.from([1, 2, 3, 4, 5]));
assert.deepEqual([...audio.snapshot(3)], [3, 4, 5]);
console.log('Passage confirmation, expected next ayah, pause scheduling, silence and seek reset checks passed.');
