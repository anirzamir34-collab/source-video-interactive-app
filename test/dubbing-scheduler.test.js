import test from 'node:test';
import assert from 'node:assert/strict';
import { createDubScheduler, DUB_LIFECYCLE } from '../public/dubbing-scheduler.js';

const line = (segmentId, startTime, endTime) => ({ segmentId, startTime, endTime });
const ids = rows => rows.map(row => row.id);
const start = (scheduler, id, generation = scheduler.get(id).generation) => {
  assert.equal(scheduler.markPlaying(id, { generation }), true);
  assert.equal(scheduler.markPlayed(id, { generation }), true);
};

test('first synchronization selects active voices without enqueuing an unseen earlier timeline', () => {
  const scheduler = createDubScheduler([line('earlier', 1, 2), line('current', 184, 189), line('later', 190, 191)]);
  assert.deepEqual(ids(scheduler.update(186)), ['current']);
  assert.deepEqual(scheduler.get('current').due, { origin: 'natural', time: 186, offset: 0, generation: 0 });
  assert.equal(scheduler.get('earlier').state, 'GENERATED');
});

test('sparse natural updates latch every crossed start even after its interval expired', () => {
  const scheduler = createDubScheduler([
    line('third', 4, 4.1), line('first', 1, 1.1), line('second', 2, 2.1), line('future', 10, 11)
  ], { initialTime: 0 });
  assert.deepEqual(ids(scheduler.update(5)), ['first', 'second', 'third']);
  for (const row of scheduler.due()) {
    assert.equal(row.state, 'DUE');
    assert.equal(row.due.origin, 'natural');
    assert.equal(row.due.offset, 0);
  }
  scheduler.update(8);
  assert.deepEqual(ids(scheduler.due()), ['first', 'second', 'third']);
});

test('cached, preparing and ready states never consume pending eligibility', () => {
  const scheduler = createDubScheduler([line('a', 1, 2)], { initialTime: 0 });
  assert.equal(scheduler.get('a').state, 'GENERATED');
  scheduler.markCached('a');
  assert.equal(scheduler.get('a').state, 'CACHED');
  scheduler.markPreparing('a');
  assert.equal(scheduler.get('a').state, 'PREPARING');
  scheduler.update(1);
  const origin = scheduler.get('a').due;
  scheduler.update(9);
  scheduler.markReady('a');
  assert.equal(scheduler.get('a').state, 'DUE');
  assert.equal(scheduler.get('a').preparationState, 'READY');
  assert.equal(scheduler.get('a').due, origin, 'late preparation keeps the immutable due selection');
  assert.equal(scheduler.counts().actualPlayedCount, 0);
  assert.equal(scheduler.counts().states.DUE, 1);
});

test('a play attempt retains due until successful playback is acknowledged', () => {
  const scheduler = createDubScheduler([line('a', 1, 2)], { initialTime: 0, generation: 7 });
  scheduler.update(1);
  const selection = scheduler.get('a').due;
  assert.equal(scheduler.markPlayed('a', { generation: 7 }), false, 'preparation alone is not playback');
  assert.equal(scheduler.markPlaying('a', { generation: 7 }), true);
  assert.equal(scheduler.get('a').state, 'PLAYING');
  assert.equal(scheduler.get('a').due, selection);
  assert.equal(scheduler.counts().startCount, 0);
  assert.equal(scheduler.markPlayed('a', { generation: 7 }), true);
  assert.equal(scheduler.get('a').state, 'PLAYED');
  assert.deepEqual(scheduler.due(), []);
  assert.equal(scheduler.counts().actualPlayedCount, 1);
  assert.equal(scheduler.counts().startCount, 1);
  assert.equal(scheduler.markPlayed('a', { generation: 7 }), false, 'duplicate promise completion does not count twice');
  assert.equal(scheduler.markEnded('a', { generation: 7 }), true);
  assert.equal(scheduler.get('a').state, 'PLAYED');
  assert.equal(scheduler.get('a').playing, false);
});

test('paused unconfirmed playback remains due and an obsolete completion cannot consume it', () => {
  const scheduler = createDubScheduler([line('a', 1, 2)], { initialTime: 0 });
  scheduler.update(1);
  scheduler.markPlaying('a', { generation: 0 });
  scheduler.markPaused('a', { generation: 0 });
  assert.equal(scheduler.get('a').state, 'DUE');
  assert.equal(scheduler.get('a').playing, false);
  assert.equal(scheduler.markPlayed('a', { generation: 0 }), false);
  assert.equal(scheduler.counts().actualPlayedCount, 0);
  start(scheduler, 'a');
  scheduler.markPaused('a', { generation: 0 });
  assert.equal(scheduler.get('a').state, 'PLAYED');
});

test('resuming a heard channel preserves PLAYED and increments actual starts without duplicate unique evidence', () => {
  const scheduler = createDubScheduler([line('a', 1, 4)], { initialTime: 0 });
  scheduler.update(1);
  start(scheduler, 'a');
  scheduler.markPaused('a', { generation: 0 });
  assert.equal(scheduler.markPlaying('a', { generation: 0 }), true);
  assert.equal(scheduler.get('a').state, 'PLAYED');
  assert.equal(scheduler.markPlayed('a', { generation: 0 }), true);
  assert.deepEqual(scheduler.due(), []);
  assert.equal(scheduler.counts().actualPlayedCount, 1);
  assert.equal(scheduler.counts().startCount, 2);
});

test('explicit seek cancels the old visit, skips past intervals and selects overlapping offsets', () => {
  const scheduler = createDubScheduler([
    line('past', 1, 2), line('long', 3, 10), line('short', 5, 8), line('future', 12, 13)
  ], { initialTime: 0, generation: 1 });
  scheduler.update(1);
  scheduler.markPlaying('past', { generation: 1 });
  assert.deepEqual(ids(scheduler.seek(6, 2)), ['long', 'short']);
  assert.equal(scheduler.get('past').state, 'SKIPPED_BY_EXPLICIT_SEEK');
  assert.equal(scheduler.get('past').playing, false);
  assert.deepEqual(scheduler.get('long').due, { origin: 'explicit-seek', time: 6, offset: 3, generation: 2 });
  assert.equal(scheduler.get('short').due.offset, 1);
  assert.equal(scheduler.get('future').state, 'GENERATED');
  assert.equal(scheduler.markPlayed('past', { generation: 1 }), false);
  assert.equal(scheduler.markPlaying('long', { generation: 1 }), false);
  assert.equal(scheduler.markEnded('past', { generation: 1 }), false);
  assert.equal(scheduler.counts().actualPlayedCount, 0);
});

test('an explicit seek selection remains fixed while newly crossed starts use zero natural offset', () => {
  const scheduler = createDubScheduler([line('selected', 1, 8), line('next', 10, 11)]);
  scheduler.seek(3, 10);
  const selection = scheduler.get('selected').due;
  scheduler.update(12);
  assert.equal(scheduler.get('selected').due, selection);
  assert.equal(scheduler.get('selected').due.offset, 2);
  assert.equal(scheduler.get('next').due.origin, 'natural');
  assert.equal(scheduler.get('next').due.offset, 0);
});

test('rewinding replays each visit while retaining cumulative unique playback and total starts', () => {
  const scheduler = createDubScheduler([line('a', 1, 2), line('b', 3, 4)], { initialTime: 0 });
  scheduler.markReady('a');
  scheduler.update(1);
  start(scheduler, 'a');
  scheduler.seek(0, 1);
  assert.equal(scheduler.get('a').playedThisVisit, false);
  assert.equal(scheduler.get('a').state, 'READY');
  assert.equal(scheduler.get('a').actualPlayed, true);
  scheduler.update(3.5);
  assert.deepEqual(ids(scheduler.due()), ['a', 'b']);
  start(scheduler, 'a', 1);
  start(scheduler, 'b', 1);
  assert.equal(scheduler.counts().actualPlayedCount, 2);
  assert.equal(scheduler.counts().startCount, 3);
  assert.equal(scheduler.get('a').playbackStarts, 2);
});

test('source preparation survives seeks while stale playback lifecycle callbacks are rejected', () => {
  const scheduler = createDubScheduler([line('a', 1, 3), line('b', 5, 8)], { initialTime: 0, generation: 1 });
  scheduler.markPreparing('a');
  scheduler.update(1);
  scheduler.markPlaying('a', { generation: 1 });
  scheduler.seek(6, 2);
  scheduler.markReady('a');
  assert.equal(scheduler.get('a').preparationState, 'READY');
  assert.equal(scheduler.get('a').state, 'SKIPPED_BY_EXPLICIT_SEEK');
  for (const method of ['markPlaying', 'markPlayed', 'markEnded', 'markPaused', 'markFailed', 'markSkipped']) {
    assert.equal(scheduler[method]('b', { generation: 1 }), false, method);
  }
  assert.equal(scheduler.get('b').state, 'DUE');
  scheduler.seek(1, 3);
  assert.equal(scheduler.get('a').state, 'DUE');
  assert.equal(scheduler.get('a').preparationState, 'READY');
});

test('valid play attempts retain cumulative evidence and timestamp while stale generations never count', () => {
  const scheduler = createDubScheduler([line('a', 1, 3), line('future', 5, 8)], { initialTime: 0, generation: 4 });
  assert.equal(scheduler.get('a').playAttemptCount, 0);
  assert.equal(scheduler.get('a').lastPlayAttemptTime, null);
  assert.equal(scheduler.get('a').lastPlayAttemptGeneration, null);
  assert.equal(scheduler.markPlaying('future', { generation: 4 }), false);
  scheduler.update(1.5);
  assert.equal(scheduler.markPlaying('a', { generation: 3, time: 100 }), false);
  assert.equal(scheduler.markPlaying('a', { generation: 4 }), true);
  assert.equal(scheduler.get('a').playAttemptCount, 1);
  assert.equal(scheduler.get('a').lastPlayAttemptTime, 1.5);
  assert.equal(scheduler.get('a').lastPlayAttemptGeneration, 4);
  scheduler.markPaused('a', { generation: 4 });
  scheduler.markPlaying('a', { generation: 4, time: 0 });
  assert.equal(scheduler.get('a').lastPlayAttemptTime, 0, 'an explicit zero timestamp is retained');
  scheduler.seek(2, 5);
  assert.equal(scheduler.get('a').playAttemptCount, 2);
  assert.equal(scheduler.get('a').lastPlayAttemptGeneration, 4);
  assert.equal(scheduler.markPlaying('a', { generation: 4, time: 20 }), false);
  assert.equal(scheduler.markPlaying('a', { generation: 5, time: 2.25 }), true);
  assert.equal(scheduler.get('a').playAttemptCount, 3);
  assert.equal(scheduler.get('a').lastPlayAttemptTime, 2.25);
  assert.equal(scheduler.get('a').lastPlayAttemptGeneration, 5);
  assert.equal(scheduler.counts().playAttemptCount, 3);
  assert.equal(scheduler.counts().actualPlayedCount, 0);
  assert.equal(scheduler.counts().startCount, 0);
});

test('visit diagnostics expose explicit seek generation and persistent skip reasons', () => {
  const scheduler = createDubScheduler([line('past', 1, 2), line('active', 3, 8), line('future', 10, 11)]);
  assert.equal(scheduler.get('past').explicitSeekGeneration, null);
  assert.equal(scheduler.get('past').skipReason, null);
  scheduler.seek(6, 12);
  assert.equal(scheduler.get('past').explicitSeekGeneration, 12);
  assert.equal(scheduler.get('past').skipReason, 'EXPLICIT_SEEK_PAST_SEGMENT');
  assert.equal(scheduler.get('active').explicitSeekGeneration, 12);
  assert.equal(scheduler.get('active').skipReason, null);
  assert.equal(scheduler.get('future').explicitSeekGeneration, 12);
  scheduler.markSkipped('active', { generation: 12, reason: 'DUB_SEEK_PAST_AUDIO' });
  scheduler.markFailed('active', { reason: 'LATE_PREPARATION_FAILURE' });
  scheduler.markReady('active');
  scheduler.markFailed('past', { reason: 'LATE_CACHE_FAILURE' });
  assert.equal(scheduler.get('active').skipReason, 'DUB_SEEK_PAST_AUDIO');
  assert.equal(scheduler.get('past').skipReason, 'EXPLICIT_SEEK_PAST_SEGMENT');
  scheduler.seek(0, 13);
  assert.equal(scheduler.get('past').explicitSeekGeneration, 13);
  assert.equal(scheduler.get('past').skipReason, null);
  assert.equal(scheduler.get('active').skipReason, null);
});

test('provider failure and late decoder recovery retain due after the source interval', () => {
  const scheduler = createDubScheduler([line('a', 1, 2)], { initialTime: 0 });
  scheduler.update(1);
  const selection = scheduler.get('a').due;
  scheduler.markFailed('a', { reason: 'PROVIDER_UNAVAILABLE' });
  assert.equal(scheduler.get('a').state, 'FAILED');
  assert.equal(scheduler.get('a').due, selection);
  assert.equal(scheduler.get('a').reason, 'PROVIDER_UNAVAILABLE');
  scheduler.update(8);
  scheduler.markPreparing('a');
  scheduler.markReady('a');
  assert.equal(scheduler.get('a').state, 'DUE');
  start(scheduler, 'a');
  scheduler.markFailed('a', { generation: 0, reason: 'DECODE_FAILED' });
  assert.equal(scheduler.get('a').playedThisVisit, false);
  assert.equal(scheduler.get('a').due, selection);
  assert.deepEqual(ids(scheduler.due()), ['a']);
  assert.equal(scheduler.counts().actualPlayedCount, 1);
  scheduler.markReady('a');
  start(scheduler, 'a');
  assert.equal(scheduler.counts().actualPlayedCount, 1);
  assert.equal(scheduler.counts().startCount, 2);
});

test('short-audio seek skips do not count as playback, and seek skip evidence survives rewind', () => {
  const scheduler = createDubScheduler([line('past', 1, 2), line('selected', 3, 8)], { initialTime: 0 });
  scheduler.seek(7, 1);
  scheduler.markSkipped('selected', { generation: 1, reason: 'SEEK_PAST_AUDIO' });
  assert.deepEqual(scheduler.due(), []);
  assert.equal(scheduler.get('selected').state, 'SKIPPED_BY_EXPLICIT_SEEK');
  assert.equal(scheduler.counts().skipped, 2);
  assert.equal(scheduler.counts().skippedByExplicitSeekCount, 2);
  assert.equal(scheduler.counts().actualPlayedCount, 0);
  scheduler.markFailed('selected', { reason: 'LATE_DECODE_FAILURE' });
  scheduler.markReady('selected');
  assert.deepEqual(scheduler.due(), [], 'late preparation does not resurrect an explicitly skipped selection');
  assert.equal(scheduler.get('selected').state, 'SKIPPED_BY_EXPLICIT_SEEK');
  assert.equal(scheduler.get('selected').reason, 'SEEK_PAST_AUDIO');
  scheduler.seek(0, 2);
  assert.equal(scheduler.counts().skipped, 0);
  assert.equal(scheduler.counts().skippedByExplicitSeekCount, 2);
  scheduler.update(4);
  assert.deepEqual(ids(scheduler.due()), ['past', 'selected']);
});

test('ordinary backwards clock corrections preserve the cursor and do not replay heard starts', () => {
  const scheduler = createDubScheduler([line('a', 1, 2), line('b', 3, 4)], { initialTime: 0 });
  scheduler.update(1);
  start(scheduler, 'a');
  scheduler.update(.9);
  assert.deepEqual(scheduler.update(1.1), []);
  assert.deepEqual(ids(scheduler.update(3.5)), ['b']);
});

test('overlapping interval selection is complete, stable and excludes end boundaries', () => {
  const scheduler = createDubScheduler([
    line('long', 0, 100), line('expired', 2, 5), line('same-first', 8, 20),
    line('same-second', 8, 20), line('ends-now', 9, 10), line('starts-now', 10, 12)
  ]);
  assert.deepEqual(ids(scheduler.seek(10, 1)), ['long', 'same-first', 'same-second', 'starts-now']);
  assert.equal(scheduler.get('ends-now').state, 'SKIPPED_BY_EXPLICIT_SEEK');
  assert.equal(scheduler.get('starts-now').due.offset, 0);
  scheduler.update(11);
  assert.deepEqual(ids(scheduler.due()), ['long', 'same-first', 'same-second', 'starts-now']);
});

test('indexed active and upcoming queries preserve overlap order without changing source eligibility', () => {
  const scheduler = createDubScheduler([
    line('future-second', 12, 14), line('same-first', 8, 20), line('long', 0, 100),
    line('same-second', 8, 20), line('ends-now', 9, 10), line('starts-now', 10, 12),
    line('future-first', 12, 15), line('expired', 2, 5)
  ]);
  assert.deepEqual(ids(scheduler.active(10)), ['long', 'same-first', 'same-second', 'starts-now']);
  assert.deepEqual(ids(scheduler.upcoming(10, 6)), [
    'long', 'same-first', 'same-second', 'starts-now', 'future-second', 'future-first'
  ]);
  assert.deepEqual(ids(scheduler.upcoming(10, 2)), ['long', 'same-first', 'same-second', 'starts-now'],
    'a preparation budget must not exclude a simultaneous voice');
  assert.deepEqual(scheduler.due(), [], 'read-only timeline queries never enqueue playback');
  scheduler.update(10);
  assert.deepEqual(ids(scheduler.active()), ['long', 'same-first', 'same-second', 'starts-now']);
  assert.equal(scheduler.get('future-second').due, null);
});

test('upcoming binary-searches a large timeline and returns only active voices plus the requested next starts', () => {
  const timeline = Array.from({ length: 2_000 }, (_, index) => line(`line-${index}`, index * 2, index * 2 + 1));
  timeline.unshift(line('long-overlap', 0, 4_001));
  const scheduler = createDubScheduler(timeline);
  // The index caches source intervals once. Re-querying or prefetching should
  // not inspect the original timeline's timestamp fields again.
  for (const segment of timeline) {
    Object.defineProperties(segment, {
      startTime: { get() { throw new Error('source timeline start scanned'); } },
      endTime: { get() { throw new Error('source timeline end scanned'); } }
    });
  }
  assert.deepEqual(ids(scheduler.active(3_900.5)), ['long-overlap', 'line-1950']);
  assert.deepEqual(ids(scheduler.upcoming(3_900.5, 6)), [
    'long-overlap', 'line-1950', 'line-1951', 'line-1952', 'line-1953', 'line-1954'
  ]);
  assert.deepEqual(ids(scheduler.upcoming(3_901.5, 3)), ['long-overlap', 'line-1951', 'line-1952']);
  assert.deepEqual(ids(scheduler.upcoming(4_000, 6)), ['long-overlap']);
  assert.deepEqual(scheduler.upcoming(4_002, 6), []);
  assert.deepEqual(scheduler.due(), []);
});

test('snapshot mutations cannot change scheduler state or the immutable selection', () => {
  const scheduler = createDubScheduler([line('a', 0, 2)]);
  scheduler.update(1);
  const row = scheduler.get('a');
  row.state = 'PLAYED';
  assert.throws(() => { row.due.offset = 1; }, TypeError);
  assert.equal(scheduler.get('a').state, 'DUE');
  assert.equal(scheduler.get('a').due.offset, 0);
  assert.equal(scheduler.transition('a', DUB_LIFECYCLE.READY), true);
  assert.equal(scheduler.transition('a', 'UNKNOWN'), false);
});

test('invalid intervals are excluded and ambiguous ids or nonfinite clocks fail explicitly', () => {
  const scheduler = createDubScheduler([
    line('zero', 1, 1), line('nan', NaN, 2), line('valid', 1, 2)
  ]);
  assert.equal(scheduler.counts().total, 1);
  assert.equal(scheduler.get('unknown'), null);
  assert.equal(scheduler.markReady('unknown'), false);
  assert.throws(() => scheduler.update(Infinity), TypeError);
  assert.throws(() => scheduler.seek(NaN), TypeError);
  assert.throws(() => createDubScheduler([line('same', 1, 2), line('same', 3, 4)]), /Duplicate/);
});
