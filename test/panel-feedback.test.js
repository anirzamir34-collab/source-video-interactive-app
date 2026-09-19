import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardVerifiedClips, clipPlaybackFeedback, sourceChoiceDisplayLabel, retainControlDismissal } from '../public/panel-feedback.js';

const clip = (id, start, end, verified = true) => ({
  id, loopStartTime: start, loopEndTime: end, sourceVerified: verified
});

test('cards show the current source label and the selected next source label when idle', () => {
  const variants = [
    { ...clip('one', 10, 20), label: 'Patikayı takip et' },
    { ...clip('two', 30, 40), label: 'Manzaraya bak · Sekans 2' }
  ];
  const choice = { label: 'Yürüyüş', variants, nextClip: variants[1] };
  assert.equal(sourceChoiceDisplayLabel(choice, variants[0]), 'Patikayı takip et');
  assert.equal(sourceChoiceDisplayLabel(choice, null), 'Manzaraya bak · Sekans 2');
  assert.equal(sourceChoiceDisplayLabel(choice, variants[1]), 'Manzaraya bak · Sekans 2');
  assert.equal(variants[1].label, 'Manzaraya bak · Sekans 2');
});

test('card labels reject foreign and unverified variants and hide internal tracking text', () => {
  const valid = { ...clip('one', 10, 20), label: "Partner A'yı dinle" };
  const invalid = { ...clip('two', 20, 30, false), label: 'Yanlış kesit' };
  const choice = { label: 'Konuşma', variants: [invalid, valid], nextClip: invalid };
  assert.equal(sourceChoiceDisplayLabel(choice, invalid), 'Onu dinle');
  assert.equal(sourceChoiceDisplayLabel(choice, { id: 'foreign', label: 'Başka sahne' }), 'Onu dinle');
  assert.equal(sourceChoiceDisplayLabel({ label: 'Konuşma', variants: [invalid] }), 'Konuşma');
});

test('a used control stays dismissed during loading and playback, then returns on completion, failure or a new scene', () => {
  let dismissed = true;
  for (const playbackState of ['loading', 'playing', 'paused', 'loading', 'playing']) {
    dismissed = retainControlDismissal(dismissed, { scopeChanged: false, playbackState });
    assert.equal(dismissed, true);
  }
  for (const playbackState of ['complete', 'error']) {
    assert.equal(retainControlDismissal(true, { scopeChanged: false, playbackState }), false);
  }
  assert.equal(retainControlDismissal(true, { scopeChanged: true, playbackState: 'playing' }), false);
  assert.equal(retainControlDismissal(false, { scopeChanged: false, playbackState: 'playing' }), false);
});

test('ending a clip cannot send forward navigation back to the first clip', () => {
  const clips = [clip('one', 10, 20), clip('two', 20, 30), clip('three', 30, 40)];
  assert.deepEqual(forwardVerifiedClips(clips, { after: 20 }).map(c => c.id), ['two', 'three']);
  assert.deepEqual(forwardVerifiedClips(clips, { currentId: 'two', after: 25 }).map(c => c.id), ['three']);
  assert.deepEqual(forwardVerifiedClips(clips, { after: 40 }), []);
});

test('navigation preserves every unique verified forward clip and never creates one', () => {
  const clips = [clip('later', 30, 40), clip('first', 20, 30), clip('first', 20, 30),
    clip('bad', null, 5), clip('reverse', 50, 40), clip('unverified', 45, 50, false)];
  const result = forwardVerifiedClips(clips, { after: 20 });
  assert.deepEqual(result.map(c => c.id), ['first', 'later']);
  assert.ok(result.every(item => clips.includes(item)));
});

test('a click or stalled seek never reports a playing card', () => {
  const item = clip('one', 10, 20);
  assert.equal(clipPlaybackFeedback(item, { currentTime: 10, paused: true, seeking: true }).state, 'loading');
  assert.equal(clipPlaybackFeedback(item, { currentTime: 10, paused: true }).state, 'paused');
  assert.equal(clipPlaybackFeedback(item, { currentTime: 12, waiting: true }).state, 'loading');
  assert.equal(clipPlaybackFeedback(item, { currentTime: 12, failed: true }).state, 'error');
});

test('real playback controls progress and completion with bounded values', () => {
  const item = clip('one', 10, 20);
  assert.deepEqual(clipPlaybackFeedback(item, { currentTime: 15, paused: false }), {
    state: 'playing', label: 'Oynuyor', progress: .5
  });
  assert.equal(clipPlaybackFeedback(item, { currentTime: 25, paused: true }).progress, 1);
  assert.equal(clipPlaybackFeedback(item, { currentTime: 25, paused: true }).state, 'complete');
  assert.equal(clipPlaybackFeedback(item, { currentTime: 5 }).progress, 0);
  assert.equal(clipPlaybackFeedback(null).state, 'idle');
});
