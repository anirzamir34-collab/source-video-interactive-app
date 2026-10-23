import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceRoles, roleCaption, createDecisionTimer } from '../public/decision-timer.js';
import { sceneChapters, sceneCardContent, characterCardContent, createExplorationTracker, playableIntervals, hasFamilyWord } from '../public/game-moments.js';
import { previewRange } from '../public/choice-preview.js';

test('the first card is the video flow, same-instant cards are real alternatives, later ones say how far they jump', () => {
  const a = { startTime: 10 }, b = { startTime: 10.5 }, c = { startTime: 33 };
  const roles = choiceRoles([c, a, b]);
  assert.equal(roles.get(a).role, 'flow');
  assert.equal(roles.get(b).role, 'alternative');
  assert.deepEqual(roles.get(c), { role: 'jump', ahead: 23 });
  assert.equal(roleCaption(roles.get(c)), 'İleri atla · +23 sn');
  assert.equal(roleCaption(roles.get(b)), '');
});

test('the countdown fires once, only while still valid, and any new decision cancels it', () => {
  const timers = [];
  const fake = { setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    setTick: () => 0, clearTick: () => {} };
  const timer = createDecisionTimer({ seconds: 8, ...fake });
  let fired = 0;
  timer.start({ onExpire: () => { fired += 1; } });
  timer.start({ onExpire: () => { fired += 10; } });
  timers[0]();
  assert.equal(fired, 0, 'a replaced countdown never fires');
  timers[1]();
  assert.equal(fired, 10);
  timer.start({ onExpire: () => { fired += 100; }, isStillValid: () => false });
  timers[2]();
  assert.equal(fired, 10, 'a decision that is no longer on screen is not played');
});

test('scene titles and character cards come from verified data and never show family roles', () => {
  const chapters = sceneChapters([{ sceneId: 'S2', startTime: 30 }, { sceneId: 'S1', startTime: 2 }, { sceneId: 'S1', startTime: 9 }]);
  assert.deepEqual([...chapters], [['S1', 1], ['S2', 2]]);
  assert.deepEqual(sceneCardContent({ sceneTitle: 'Akşam ziyareti' }, { chapter: 1, names: ['Selin'] }),
    { kicker: 'Bölüm 1', title: 'Akşam ziyareti', people: ['Selin'] });
  assert.equal(sceneCardContent({ sceneTitle: 'Üvey annesiyle yemek' }, { chapter: 2, setting: 'Mutfak' }).title, 'Mutfak');
  const card = characterCardContent({ evidenceLevel: 'fact', sourceRole: 'Komşu', speakerIds: ['w'] }, { name: 'Selin',
    cues: [{ speakerId: 'w', start: 3, text: 'Ah' }, { speakerId: 'w', start: 5, text: 'Bu akşam erken geldin.' }] });
  assert.deepEqual(card, { name: 'Selin', role: 'Komşu', line: 'Bu akşam erken geldin.' });
  assert.equal(characterCardContent({ evidenceLevel: 'fact', sourceRole: 'Annesi' }, { name: 'Selin' }).role, '');
  assert.equal(hasFamilyWord('Hala burada'), false);
});

test('exploration counts only continuous playback inside playable parts', () => {
  const tracker = createExplorationTracker(playableIntervals([{ startTime: 0, endTime: 10 }, { startTime: 20, endTime: 30 }]));
  for (let t = 0; t <= 5; t += 0.5) tracker.record(t);
  tracker.record(25); // a seek is not watching
  assert.equal(tracker.percent(), 25);
});

test('a preview shows 3 seconds from inside the part', () => {
  assert.deepEqual(previewRange(10, 20), { start: 11, end: 14 });
  assert.deepEqual(previewRange(10, 12), { start: 10, end: 12 });
  assert.equal(previewRange(5, 5), null);
});
