import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceSurfaceForAction, withChoiceSurface, choiceSurfaceWindow, sceneSurfaceChoices,
  distinctVerifiedSourceChoices, sceneOwnsStoryChoice, sceneOwnsApproachChoice } from '../public/choice-routing.js';
import { groupSourceChoiceCards } from '../public/choice-groups.js';
import { reviewAndHardenAnalysis } from '../public/engine-hardening.js';

const action = extra => ({ actionId: 'source-a', sourceVerified: true, confidence: 0.95,
  label: 'Observed source action', startTime: 10, endTime: 15, actionType: 'other', ...extra });

test('scene envelopes and generic motion cannot turn a story action into an opening choice', () => {
  for (const actionType of ['other', 'dialogue', 'story', 'body_transition', 'movement', 'tempo_change', 'camera_transition']) {
    assert.equal(choiceSurfaceForAction(action({ actionType, adultScene: true, adultSceneId: 'same-scene' })), 'story');
  }
});

test('existing verified action kinds have one surface even when their source contains speech', () => {
  assert.equal(choiceSurfaceForAction(action({ actionType: 'kiss', transcript: 'An existing line',
    choiceSurfaceEvidence: 'The people visibly kiss in this source interval.', choiceSurfaceConfidence: 0.92 })), 'approach');
  assert.equal(choiceSurfaceForAction(action({ positionId: 'opaque-class', classificationReview: 'verified' })), 'story');
  assert.equal(choiceSurfaceForAction(action({ positionId: 'opaque-class' }), { panelFamily: 'rear' }), 'panel');
  assert.equal(choiceSurfaceForAction(action({ actionType: 'dialogue' })), 'story');
  assert.equal(choiceSurfaceForAction(action({ sourceVerified: false, actionType: 'kiss' })), 'unverified');
});

test('ordinary hand gestures and dialogue wording do not promote a story action', () => {
  assert.equal(choiceSurfaceForAction(action({ label: 'Elini şakağına götürüp konuş', adultScene: true })), 'story');
  assert.equal(choiceSurfaceForAction(action({ label: 'Kollarını bağlayıp izle', adultScene: true })), 'story');
});

test('spoken invitations and uncorroborated contact tags remain ordinary choices', () => {
  const dialogue = action({ actionType: 'dialogue', label: 'Seks yapalım dedi',
    transcript: 'Seks yapalım', choiceSurface: 'approach',
    choiceSurfaceEvidence: 'Only spoken words; the visible people are talking', choiceSurfaceConfidence: .99 });
  assert.equal(choiceSurfaceForAction(dialogue), 'story');
  for (const actionType of ['kiss', 'touch', 'clothing']) {
    const spokenOnly = action({ actionType, choiceSurface: 'approach',
      label: 'A speculative interaction suggested by dialogue',
      choiceSurfaceEvidence: 'Only spoken words; no corresponding visible event',
      choiceSurfaceConfidence: 0.99 });
    assert.equal(choiceSurfaceForAction(spokenOnly), 'story');
  }
});

test('a declared category requires interval evidence and confidence and cannot create a panel', () => {
  const opening = action({ actionType: 'body_transition', choiceSurface: 'approach' });
  assert.equal(choiceSurfaceForAction(opening), 'story');
  assert.equal(choiceSurfaceForAction({ ...opening, choiceSurfaceEvidence: 'Source interval evidence', choiceSurfaceConfidence: 0.59 }), 'story');
  assert.equal(choiceSurfaceForAction({ ...opening, choiceSurfaceEvidence: 'Source interval evidence', choiceSurfaceConfidence: 0.95 }), 'approach');
  assert.equal(choiceSurfaceForAction(action({ choiceSurface: 'panel', choiceSurfaceConfidence: 1, choiceSurfaceEvidence: 'A scene label' })), 'story');
});

test('an explicitly evidenced ordinary contact keeps its story category', () => {
  assert.equal(choiceSurfaceForAction(action({ actionType: 'touch', choiceSurface: 'story',
    choiceSurfaceConfidence: 0.95, choiceSurfaceEvidence: 'An ordinary greeting' })), 'story');
});

test('observed contact and kissing keep their opening surface when a provider calls them story', () => {
  for (const actionType of ['touch', 'kiss']) {
    assert.equal(choiceSurfaceForAction(action({ actionType, choiceSurface: 'story',
      choiceSurfaceEvidence: 'The same pair visibly draw closer and touch.', choiceSurfaceConfidence: 0.94 })), 'approach');
  }
  assert.equal(choiceSurfaceForAction(action({ actionType: 'body_transition', choiceSurface: 'story',
    choiceSurfaceEvidence: 'They change posture.', choiceSurfaceConfidence: 0.94 })), 'story');
});

test('choice windows stop at the next category boundary instead of offering later source clips', () => {
  const rows = [
    action({ id: 'opening-a', choiceSurface: 'approach', startTime: 109.5, endTime: 117 }),
    action({ id: 'talk-a', choiceSurface: 'story', startTime: 117, endTime: 126.5 }),
    action({ id: 'talk-b', choiceSurface: 'story', startTime: 126.5, endTime: 136.5 }),
    action({ id: 'talk-c', choiceSurface: 'story', startTime: 136.5, endTime: 149.5 }),
    action({ id: 'opening-b', choiceSurface: 'approach', startTime: 149.5, endTime: 153.8 })
  ];
  assert.deepEqual(choiceSurfaceWindow(rows, 'approach', 109.5).map(row => row.id), ['opening-a']);
  assert.deepEqual(choiceSurfaceWindow(rows, 'story', 117).map(row => row.id), ['talk-a', 'talk-b', 'talk-c']);
  assert.deepEqual(choiceSurfaceWindow(rows, 'approach', 117), []);
  assert.deepEqual(choiceSurfaceWindow(rows, 'approach', 149.5).map(row => row.id), ['opening-b']);
});

test('a global choice surface removes duplicate provider rows without losing real alternatives', () => {
  const row = (id, extra = {}) => action({
    id, sourceActionId: 'observed:1', choiceSurface: 'story',
    participantTrackIds: ['MAIN', 'OTHER'], startTime: 10, endTime: 16, ...extra
  });
  const first = row('card-a', { label: 'Soruyu sor' });
  const copied = row('card-b', { label: 'Yanıtı bekle' });
  const later = row('card-c', { startTime: 20, endTime: 25 });
  const differentSource = row('card-d', { sourceActionId: 'observed:2' });
  const differentCast = row('card-e', { participantTrackIds: ['MAIN', 'THIRD'] });
  const unverified = row('invalid', { sourceVerified: false });
  const input = [first, copied, later, differentSource, differentCast, unverified];
  const copy = structuredClone(input);
  assert.deepEqual(distinctVerifiedSourceChoices(input).map(item => item.id),
    ['card-a', 'card-c', 'card-d', 'card-e']);
  assert.deepEqual(sceneSurfaceChoices(input, 'story', { ceiling: 30 }).map(item => item.id),
    ['card-a', 'card-d', 'card-e', 'card-c']);
  assert.deepEqual(choiceSurfaceWindow(input, 'story', 10).map(item => item.id),
    ['card-a', 'card-d', 'card-e', 'card-c']);
  assert.deepEqual(input, copy, 'source analysis and playback ranges remain untouched');
});

test('global choice dedup never merges identical labels across source categories', () => {
  const first = action({ id: 'story', sourceActionId: 'source:1', choiceSurface: 'story',
    label: 'Devam et' });
  const second = { ...first, id: 'different-category', choiceSurface: 'approach' };
  const third = { ...first, id: 'another-occurrence', sourceOccurrenceId: 'visit-2' };
  assert.deepEqual(distinctVerifiedSourceChoices([first, second, third]).map(item => item.id),
    ['story', 'different-category', 'another-occurrence']);
  assert.deepEqual(sceneSurfaceChoices([first, second, third], 'story').map(item => item.id),
    ['story', 'another-occurrence']);
});

test('identical labels and origins never combine different category clips into one card', () => {
  const clips = ['story', 'approach', 'panel'].map((choiceSurface, i) => action({
    id: `clip-${i}`, sourceActionId: 'shared-origin', actionType: 'other', movementType: 'same-kind',
    choiceSurface, startTime: i * 5, endTime: i * 5 + 4,
    loopStartTime: i * 5, loopEndTime: i * 5 + 4
  }));
  const cards = groupSourceChoiceCards(clips, { contextFor: () => 'same-context', mergeWithinContext: true, preferredCount: 1 });
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => new Set(card.variants.map(clip => clip.choiceSurface)).size === 1));
});

test('only an exact verified source ID owns a story choice, not a scene-wide time envelope', () => {
  const scene = { startTime: 0, endTime: 200, dialogue: [{ id: 'entry', sourceActionId: 'source-a', sourceVerified: true }] };
  assert.equal(sceneOwnsStoryChoice(scene, action()), true);
  assert.equal(sceneOwnsStoryChoice(scene, action({ actionId: 'different-source' })), false);
});

test('a scene owns only its explicitly linked opening contacts', () => {
  const scene = { foreplay: [{ id: 'contact', sourceActionId: 'source-a', sourceVerified: true }] };
  assert.equal(sceneOwnsApproachChoice(scene, action()), true);
  assert.equal(sceneOwnsApproachChoice(scene, action({ actionId: 'later-contact' })), false);
});

test('hardening preserves source times and assigns separate source categories without provider calls', () => {
  const input = action({ actionType: 'kiss', choiceSurfaceEvidence: 'The source visibly shows a kiss.', choiceSurfaceConfidence: 0.93 });
  const original = structuredClone(input);
  const result = reviewAndHardenAnalysis({ videoDuration: 30, actions: [input, action({ actionId: 'line', startTime: 16, endTime: 21, actionType: 'dialogue' })] });
  assert.deepEqual(result.analysis.actions.map(row => row.choiceSurface), ['approach', 'story']);
  assert.deepEqual(input, original);
  assert.deepEqual([withChoiceSurface(input).startTime, withChoiceSurface(input).endTime], [10, 15]);
});

test('stale activity metadata cannot push observed opening actions into the position surface', () => {
  for (const actionType of ['kiss', 'touch']) {
    const source = action({ actionType, choiceSurface: 'panel',
      positionId: '', positionLabel: '', activityType: 'oral',
      activityTypeConfidence: 0.95, activityEvidence: 'Unverified provider claim' });
    assert.equal(choiceSurfaceForAction(source), 'approach');
  }
});
