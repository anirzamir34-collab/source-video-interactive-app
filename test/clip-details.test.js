import test from 'node:test';
import assert from 'node:assert/strict';
import { clipDetailPage, clipDetailTime } from '../public/clip-details.js';

const clip = (id, start, end, verified = true) => Object.freeze({
  id, loopStartTime: start, loopEndTime: end, sourceVerified: verified
});

test('all 18 existing clips remain reachable as metadata across five small pages', () => {
  const clips = Object.freeze(Array.from({ length: 18 }, (_, i) => clip(`c${i}`, 10 + i * 8, 18 + i * 8)));
  const pages = Array.from({ length: 5 }, (_, i) => clipDetailPage(clips, i));
  assert.deepEqual(pages.map(page => page.rows.length), [4, 4, 4, 4, 2]);
  assert.deepEqual(pages.flatMap(page => page.rows.map(row => row.id)), clips.map(item => item.id));
  assert.deepEqual(pages.flatMap(page => page.rows.map(row => row.number)), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(pages[0].hasPrevious, false);
  assert.equal(pages.at(-1).hasNext, false);
  assert.equal(pages[2].total, 18);
});

test('invalid or unverified ranges never appear as available source metadata', () => {
  const valid = clip('ok', 5.1, 8.8);
  const result = clipDetailPage([valid, valid, clip('no', 10, 12, false),
    clip('bad', '', 2), clip('reverse', 4, 3), clip('bool', false, 2), clip('negative', -1, 3)]);
  assert.deepEqual(result.rows, [{ id: 'ok', start: 5.1, end: 8.8, number: 1 }]);
  assert.equal(result.pageCount, 1);
});

test('empty, smaller and out-of-range pages settle on a valid boundary', () => {
  assert.deepEqual(clipDetailPage(), { rows: [], page: 0, pageCount: 0, total: 0, hasPrevious: false, hasNext: false });
  const clips = Array.from({ length: 6 }, (_, i) => clip(`c${i}`, i, i + 1));
  assert.equal(clipDetailPage(clips, 99).page, 1);
  assert.equal(clipDetailPage(clips, -3).page, 0);
  assert.equal(clipDetailPage(clips, NaN).page, 0);
  assert.equal(clipDetailPage(clips, Infinity).page, 0);
  assert.equal(clipDetailPage(clips.slice(0, 1), 99).rows.length, 1);
});

test('time labels stay compact across minute and hour boundaries', () => {
  assert.equal(clipDetailTime(0), '0:00');
  assert.equal(clipDetailTime(59.9), '0:59');
  assert.equal(clipDetailTime(60), '1:00');
  assert.equal(clipDetailTime(3665), '1:01:05');
  assert.equal(clipDetailTime(null), '—');
});
