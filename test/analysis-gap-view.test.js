import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisReviewItems } from '../public/analysis-gap-view.js';

test('review includes provider gaps and discarded source evidence in time order', () => {
  const items = analysisReviewItems({
    analysisGaps: [{ chunkIndex: 7, startTime: 1001.3, endTime: 1183.3,
      reason: 'GEMINI_CONTENT_RESTRICTED' }],
    warnings: [{ code: 'VERIFIED_APPROACH_REJECTED', actionId: 'tl-002',
      sourceStartTime: 33.7, sourceEndTime: 62.2, membershipReason: 'NO_VERIFIED_SCENE_MEMBERSHIP' }]
  }, 1729.5);
  assert.equal(items.length, 2);
  assert.equal(items[0].startTime, 33.7);
  assert.equal(items[1].title, 'Eksik bölüm 8');
  assert.match(items[1].detail, /Hangi tek karenin/);
});

test('empty neutral repair gaps are explained in Turkish without raw codes', () => {
  const items = analysisReviewItems({
    analysisGaps: [
      { startTime: 276.5, endTime: 331.8, reason: 'NEUTRAL_REPAIR_UNVERIFIED' },
      { startTime: 497.7, endTime: 553, reason: 'GEMINI_NO_VERIFIED_EVENTS' }
    ]
  }, 900);
  assert.equal(items.length, 2);
  assert.match(items[0].detail, /doğrulanabilir bir olay bulunamadı/);
  assert.match(items[1].detail, /doğrulanmış yeni sahne olayı üretemedi/);
  assert.ok(items.every(item => !item.detail.includes('NEUTRAL_REPAIR_UNVERIFIED')));
});
