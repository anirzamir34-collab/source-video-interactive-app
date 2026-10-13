import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceOpeningTimeline } from '../public/source-opening.js';

test('retains source intro time metadata', () => {
  assert.deepEqual(sourceOpeningTimeline({
    introEndTime: 42.75, playStartTime: 42.75, videoDuration: 320,
    actions: [{ startTime: 49, endTime: 60, sourceVerified: true }]
  }), { introEndTime: 42.75, playStartTime: 42.75 });
});

test('cannot skip a verified event at start', () => {
  assert.deepEqual(sourceOpeningTimeline({
    introEndTime: 90, playStartTime: 90, videoDuration: 320,
    actions: [{ startTime: 70, endTime: 80, sourceVerified: true }]
  }), { introEndTime: 70, playStartTime: 70 });
});

test('missing or unusable opening metadata defaults to available action', () => {
  assert.deepEqual(sourceOpeningTimeline({
    introEndTime: null, playStartTime: null, videoDuration: 320,
    actions: [{ startTime: 12, endTime: 20, sourceVerified: true }]
  }), { introEndTime: 12, playStartTime: 12 });
  assert.deepEqual(sourceOpeningTimeline({
    introEndTime: -5, playStartTime: 'invalid', videoDuration: 100,
    actions: [{ startTime: 20, endTime: 25, sourceVerified: true }]
  }), { introEndTime: 20, playStartTime: 20 });
});
