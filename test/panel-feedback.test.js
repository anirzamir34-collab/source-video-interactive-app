import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPanelFeedback, forwardVerifiedClips, clipPlaybackFeedback, sourceChoiceDisplayLabel, retainControlDismissal } from '../public/panel-feedback.js';

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
  assert.equal(sourceChoiceDisplayLabel(choice, null), 'Manzaraya bak');
  assert.equal(sourceChoiceDisplayLabel(choice, variants[1]), 'Manzaraya bak');
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

test('playback feedback keeps the verified target identity when a subclip replaces the card heading', () => {
  const identified = { id: 'named', label: 'Hareketi sürdür', sourceVerified: true,
    identityResolution: 'verified', primaryCharacterLabel: 'Deniz' };
  assert.equal(sourceChoiceDisplayLabel({ label: 'Hareket', variants: [identified] }, identified),
    'Hareketi sürdür · Deniz');
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

test('a completed paused seek clears old buffering only when source media is ready', t => {
  const frames = [];
  const label = { textContent: '' };
  const win = {
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} }
  };
  const doc = { defaultView: win,
    getElementById: id => id === 'panelPlaybackStatus' ? label : null,
    createTreeWalker: () => ({ nextNode: () => null }) };
  const stage = { ownerDocument: doc, classList: { toggle() {} } };
  const panel = { ownerDocument: doc, querySelectorAll: () => [] };
  const video = new EventTarget();
  Object.assign(video, { currentTime: 12, paused: false, seeking: false, readyState: 4 });
  const cleanup = attachPanelFeedback({ stage, panel, video,
    getSnapshot: () => ({ scope: 'walk', controlScope: 'walk', clip: clip('trail', 10, 20) }) });
  t.after(cleanup);
  const flush = () => { while (frames.length) frames.shift()(); };
  const fire = name => { video.dispatchEvent(new Event(name)); flush(); };
  flush();
  assert.equal(label.textContent, 'Oynuyor');
  fire('waiting');
  assert.equal(label.textContent, 'Hazırlanıyor');
  video.paused = true; video.seeking = true;
  fire('seeking');
  video.seeking = false; video.readyState = 2;
  fire('seeked');
  assert.equal(label.textContent, 'Hazırlanıyor', 'a seek cannot clear genuine buffering');
  video.readyState = 4;
  fire('seeked');
  assert.equal(label.textContent, 'Duraklatıldı', 'ready paused media must not retain an old wait');
  video.paused = false;
  fire('playing');
  assert.equal(label.textContent, 'Oynuyor');
});
