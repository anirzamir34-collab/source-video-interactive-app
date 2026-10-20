import test from 'node:test';
import assert from 'node:assert/strict';
import { trimIntroOutro, isNonStoryScreen } from '../public/intro-outro.js';

const A = (actionId, startTime, endTime, label, actionType = 'story', extra = {}) =>
  ({ actionId, startTime, endTime, label, actionType, choiceSurface: 'story', ...extra });

test('opening logo and closing screen are trimmed; play starts and ends around them', () => {
  const result = trimIntroOutro([
    A('logo', 0, 8, 'Logo ekranını izle', 'scene_transition'),
    A('door', 8, 20, 'Kapıyı aç'),
    A('talk', 20, 30, 'Fragman hakkında konuş', 'dialogue'),
    A('end', 30, 40, 'Kapanış ekranını izle', 'scene_transition')
  ], { duration: 50 });
  assert.deepEqual(result.actions.map(item => item.actionId), ['door', 'talk']);
  assert.equal(result.playStartTime, 8);
  assert.equal(result.playEndTime, 30);
});

test('footage before the first event is skipped unless an unanalyzed gap sits there', () => {
  assert.equal(trimIntroOutro([A('a', 44.8, 50, 'Konuş')], { introEndTime: 0, duration: 60 }).playStartTime, 44.8);
  assert.equal(trimIntroOutro([A('a', 44.8, 50, 'Konuş')], { introEndTime: 0, duration: 60,
    analysisGaps: [{ startTime: 0, endTime: 40 }] }).playStartTime, 0);
});

test('only screens at the edges are trimmed, never dialogue or adult scenes', () => {
  assert.equal(isNonStoryScreen(A('x', 0, 1, 'Tanıtım hakkında konuş', 'dialogue')), false);
  assert.equal(isNonStoryScreen(A('x', 0, 1, 'Logo', 'scene_transition', { adultScene: true })), false);
  const middle = trimIntroOutro([A('a', 0, 5, 'Konuş'), A('b', 5, 9, 'Reklam arası', 'scene_transition'), A('c', 9, 15, 'Devam et')]);
  assert.equal(middle.actions.length, 3);
});
