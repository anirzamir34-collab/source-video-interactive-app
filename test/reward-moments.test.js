import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRewardMoments, rewardsForScene, derivedHighlight, pickAdultReward } from '../public/reward-moments.js';

test('only verified 3-45 s rewards of known types survive; clip times are shifted', () => {
  const rows = normalizeRewardMoments([
    { rewardType: 'her_climax', startTime: 10, endTime: 18, sourceVerified: true, label: 'Zirveye ulaşıyor' },
    { rewardType: 'highlight', startTime: 30, endTime: 31, sourceVerified: true },
    { rewardType: 'other', startTime: 40, endTime: 50, sourceVerified: true },
    { rewardType: 'highlight', startTime: 40, endTime: 50, sourceVerified: false }
  ], { chunkStart: 300, chunkEnd: 400 });
  assert.deepEqual(rows.map(row => [row.rewardType, row.startTime, row.endTime]), [['her_climax', 310, 318]]);
});

test('her climax comes after Lust fills once more during sex; highlight needs three fills', () => {
  const climax = { id: 'c', rewardType: 'her_climax' }, highlight = { id: 'h', rewardType: 'highlight' };
  assert.equal(pickAdultReward([climax, highlight], { lustFills: 1 }), null);
  assert.equal(pickAdultReward([climax, highlight], { lustFills: 2 }), climax);
  assert.equal(pickAdultReward([highlight], { lustFills: 2 }), null);
  assert.equal(pickAdultReward([highlight], { lustFills: 3 }), highlight);
  assert.equal(pickAdultReward([climax, highlight], { lustFills: 3, played: new Set(['c']) }), highlight);
  assert.equal(pickAdultReward([highlight], { lustFills: 5, offered: new Set(['h']) }), null);
});

test('rewards outside the scene are ignored and a derived highlight is a real movement', () => {
  const scene = { startTime: 100, endTime: 200, positions: [{ movements: [
    { sourceVerified: true, loopStartTime: 120, loopEndTime: 134, maleProgressRate: 1 },
    { sourceVerified: true, loopStartTime: 170, loopEndTime: 184, maleProgressRate: 2, movementTempo: 'fast' }] }] };
  assert.equal(rewardsForScene([{ startTime: 90, endTime: 95 }, { startTime: 150, endTime: 160 }], scene).length, 1);
  const derived = derivedHighlight(scene);
  assert.deepEqual([derived.startTime, derived.endTime, derived.derived], [170, 184, true]);
  assert.equal(derivedHighlight({ startTime: 0, endTime: 10, positions: [] }), null);
});
