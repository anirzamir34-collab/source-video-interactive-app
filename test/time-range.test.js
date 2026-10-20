import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, formatClock, resolveCutRange } from '../public/time-range.js';

test('clock text parses as minutes:seconds, hours or bare minutes', () => {
  assert.equal(parseClock('12:30'), 750);
  assert.equal(parseClock('1:02:05'), 3725);
  assert.equal(parseClock('12'), 720);
  assert.equal(parseClock(''), null);
  assert.ok(Number.isNaN(parseClock('12:75')));
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(750), '12:30');
});

test('cut range is checked against the video length', () => {
  assert.deepEqual(resolveCutRange('10:00', '', 1800), { start: 600, end: 1800 });
  assert.deepEqual(resolveCutRange('', '5:00', 1800), { start: 0, end: 300 });
  assert.deepEqual(resolveCutRange('10:00', '40:00', 1800), { start: 600, end: 1800 });
  assert.match(resolveCutRange('31:00', '', 1800).error, /süresinden/);
  assert.match(resolveCutRange('10:00', '10:02', 1800).error, /5 saniye/);
  assert.match(resolveCutRange('', '', 1800).error, /boş/);
});
