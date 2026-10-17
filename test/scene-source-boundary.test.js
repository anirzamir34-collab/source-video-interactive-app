import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sourceOutsideScene } from '../public/scene-source-boundary.js';

test('a source chapter owns its interval, not later ordinary scenes', () => {
  const first = { id: 'a', startTime: 138, endTime: 240 };
  assert.equal(sourceOutsideScene(first, 138), false);
  assert.equal(sourceOutsideScene(first, 184), false);
  assert.equal(sourceOutsideScene(first, 240), false);
  assert.equal(sourceOutsideScene(first, 240.15), false);
  assert.equal(sourceOutsideScene(first, 277), true);
  assert.equal(sourceOutsideScene(first, 415), true);
  assert.equal(sourceOutsideScene(first, 829), true);
  assert.equal(sourceOutsideScene(first, 0), true);
  assert.equal(sourceOutsideScene(null, 800), false);
});
test('unknown source time or malformed scene cannot falsely close a real panel', () => {
  assert.equal(sourceOutsideScene({ startTime: 1, endTime: 5 }, NaN), false);
  assert.equal(sourceOutsideScene({ startTime: 8, endTime: 5 }, 9), false);
});
test('source transition reclaims panel before interactive playback is processed', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function updateAdultPlayback(now, mediaTime)');
  const guard = app.indexOf('if (sourceOutsideScene(state.adultScene, mediaTime))', start);
  const progress = app.indexOf('observeInteractionProgress(mediaTime);', start);
  assert.ok(start >= 0 && guard > start && guard < progress);
  assert.match(app.slice(guard, progress), /reconcileInteractionSeek\(mediaTime\)/);
});
test('dubbing requests the automatic ElevenLabs provider while non-dubbing mode is unchanged', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function selectedAnalysisModes()');
  const end = app.indexOf('function updateAnalysisModesUI()', start);
  assert.ok(start > 0 && end > start);
  assert.match(app.slice(start, end),
    /dubbingProvider: els\.dubMode\?\.checked \? 'elevenlabs_v1' : 'classic'/);
  const pipeline = fs.readFileSync(new URL('../lib/turkish-media/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /\['elevenlabs', 'elevenlabs_v1'\]\.includes\(input\.outputs\?\.dubbingProvider\)/);
  assert.match(pipeline, /modelId: input\.outputs\.dubbingProvider === 'elevenlabs_v1' \? 'dubbing_v1'/);
});
