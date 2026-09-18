import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as gameplay from '../public/adult-gameplay.js';
import { sourceRangeForClip } from '../public/sequence-integrity.js';

// Run the actual graph preparation with a neutral classifier stub. These tests
// concern provenance and timeline integrity, not visual classification quality.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function prepareAdultScenes()');
const end = source.indexOf('\nfunction adultAnalysisTraceText()', start);
const handler = source.slice(start, end);
const action = (id, start, end, extra = {}) => ({
  actionId: id, label: `Observed action ${id}`, sourceVerified: true, confidence: 0.95,
  adultScene: true, adultSceneId: 'scene-a', adultSceneStartTime: 0, adultSceneEndTime: 200,
  positionId: 'chapter', positionLabel: 'Chapter', positionOccurrenceId: 'chapter-a',
  positionStartTime: 0, positionEndTime: 200, startTime: start, endTime: end,
  loopStartTime: start, loopEndTime: end, ...extra
});

function prepare(actions) {
  const state = { analysis: { actions }, analysisFingerprint: 'test' };
  const scope = vm.createContext({
    ...gameplay, state, ENGINE_VERSION: 'test',
    verifiedAdultPositionFamily: item => item.sourceVerified ? 'chapter' : '',
    canonicalAdultPosition: () => ({ id: 'chapter', label: 'Chapter' }),
    adultCategoryFor: () => ({ id: 'chapter', label: 'Chapter' }),
    activityOccurrenceNamespace: () => 'unclear',
    activityDisplayLabel: label => label,
    normalizeAdultLabel: value => String(value).toLowerCase(),
    movementBelongsToVerifiedPosition: item => item.sourceVerified === true && item.accepted !== false,
    mergeAdultSceneFragments: scenes => scenes,
    isWarmupPosition: () => false, isBonusPosition: () => false,
    renderAdultAnalysisTrace() {}
  });
  vm.runInContext(`${handler}\nprepareAdultScenes();`, scope);
  return state;
}

test('preparation never fabricates a verified full-parent clip from rejected evidence', () => {
  const state = prepare([action('rejected', 10, 30, { accepted: false })]);
  assert.equal(state.adultScenes.length, 0);
});

test('short source evidence does not authorize a longer parent fallback', () => {
  const state = prepare([action('short', 10, 11)]);
  assert.equal(state.adultScenes.length, 0);
});

test('wide parent declarations preserve only the exact accepted source intervals', () => {
  const state = prepare([
    action('first', 10, 30, { sourcePositionId: 'provider-parent' }), action('later', 90, 110),
    action('unverified', 35, 85, { sourceVerified: false })
  ]);
  assert.equal(state.adultScenes.length, 1);
  const positions = state.adultScenes[0].positions;
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.deepEqual(Array.from(p.sourceRanges, r => [r.startTime, r.endTime]), [[10, 30], [90, 110]]);
  assert.ok(p.movements.every(m => sourceRangeForClip(p, m)));
  assert.equal(p.movements.some(m => m.positionOnlyFallback), false);
  assert.equal(p.movementChoices.flatMap(c => c.variants).some(m => m.id === p.entryMovementId), false);
  assert.equal(new Set([p.entryMovementId, ...p.movementChoices.flatMap(c => c.variants).map(m => m.id)]).size,
    p.movements.length);
});

test('separate scenes retain separate parent cards and source intervals', () => {
  const state = prepare([
    action('first', 10, 30),
    action('last', 310, 330, { adultSceneId: 'scene-b', adultSceneStartTime: 300,
      adultSceneEndTime: 400, positionStartTime: 300, positionEndTime: 400 })
  ]);
  assert.equal(state.adultScenes.length, 2);
  assert.equal(state.adultScenes[0].positions[0].movements.every(m => m.loopEndTime <= 30), true);
  assert.equal(state.adultScenes[1].positions[0].movements.every(m => m.loopStartTime >= 310), true);
});
