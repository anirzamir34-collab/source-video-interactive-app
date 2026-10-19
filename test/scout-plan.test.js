import test from 'node:test';
import assert from 'node:assert/strict';
import { scoutFrameIndexes, normalizeScoutSegments, scoutChunkPlan, scoutEligible } from '../public/scout-plan.js';
import { sanitizeScoutSegments } from '../lib/scout-route.js';
import { storyboardSamplingPlan } from '../public/storyboard.js';

const storyboardOf = (duration, spacing = 3) => {
  const timestamps = [];
  for (let time = 0; time < duration; time += spacing) timestamps.push(time);
  return { duration, timestamps, sheets: Array.from({ length: Math.ceil(timestamps.length / 12) }, () => ({})) };
};

test('scout runs only for 25+ minute deep analysis', () => {
  assert.equal(scoutEligible(1499, 'deep'), false);
  assert.equal(scoutEligible(1500, 'deep'), true);
  assert.equal(scoutEligible(3600, 'economy'), false);
});

test('long local videos are sampled about every 3 seconds', () => {
  assert.equal(storyboardSamplingPlan(2400).baseCount, 800);
  assert.equal(storyboardSamplingPlan(600).baseCount, 192);
});

test('scout frames are sparse and keep the first and last frame', () => {
  const board = storyboardOf(1800);
  const picked = scoutFrameIndexes(board.timestamps, 18);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), board.timestamps.length - 1);
  assert.ok(picked.length < board.timestamps.length / 5);
});

test('gaps in the scout timeline become uncertain, never skipped', () => {
  const rows = normalizeScoutSegments([{ startTime: 0, endTime: 100, kind: 'story' },
    { startTime: 200, endTime: 300, kind: 'intimate' }], 400);
  assert.deepEqual(rows.map(row => row.kind), ['story', 'uncertain', 'intimate', 'uncertain']);
  assert.equal(rows.at(-1).endTime, 400);
});

test('story is grouped widely, intimate ranges get small dense requests, every sheet once', () => {
  const board = storyboardOf(2400);
  const plan = scoutChunkPlan(board, [
    { startTime: 0, endTime: 1500, kind: 'story' },
    { startTime: 1500, endTime: 1560, kind: 'approach' },
    { startTime: 1560, endTime: 2100, kind: 'intimate' },
    { startTime: 2100, endTime: 2400, kind: 'story' }
  ]);
  const covered = plan.chunks.flatMap(chunk => Array.from({ length: chunk.sheetCount }, (_, i) => chunk.firstSheet + i));
  assert.deepEqual(covered, Array.from({ length: board.sheets.length }, (_, i) => i));
  assert.ok(plan.chunks.filter(chunk => chunk.focusTier === 'detailed').every(chunk => chunk.sheetCount <= 2));
  assert.ok(plan.chunks.filter(chunk => chunk.focusTier === 'overview').some(chunk => chunk.sheetCount >= 4));
  assert.ok(plan.chunkCount < board.sheets.length, 'fewer requests than one per sheet');
  const intimateSheet = Math.floor((1800 / 3) / 12);
  const chunk = plan.chunks.find(row => intimateSheet >= row.firstSheet && intimateSheet < row.firstSheet + row.sheetCount);
  assert.equal(chunk.focusTier, 'detailed');
});

test('scout model output is clamped to its interval and unknown kinds become uncertain', () => {
  const rows = sanitizeScoutSegments({ segments: [{ startTime: -5, endTime: 50, kind: 'story' },
    { startTime: 50, endTime: 999, kind: 'party' }] }, { startTime: 0, endTime: 120 });
  assert.deepEqual(rows, [{ startTime: 0, endTime: 50, kind: 'story' }, { startTime: 50, endTime: 120, kind: 'uncertain' }]);
});
