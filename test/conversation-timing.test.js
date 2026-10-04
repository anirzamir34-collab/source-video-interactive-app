import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { conversationEnd } from '../public/conversation-timing.js';

test('a decision waits for original speech and the longer audible dub, with a short breathing gap', () => {
  const source = [{ startTime: 1, endTime: 3 }];
  const dub = [{ start: 1, end: 5, words: [{ start: 1, end: 4 }] }];
  assert.equal(conversationEnd(2, source, dub, { dubEnabled: true }), 4.12);
  assert.equal(conversationEnd(2, source, dub, { dubEnabled: false }), 3.12);
  assert.equal(conversationEnd(5, source, dub, { dubEnabled: true }), 5);
  assert.equal(conversationEnd(2, [], dub, { dubEnabled: true, offset: .5 }), 3.62);
  assert.equal(conversationEnd(2, [], dub, { dubEnabled: true, duration: 3 }), 3);
});

test('nearby speech continues without a premature choice, but a later unrelated sentence does not delay it', () => {
  const source = [{ startTime: 1, endTime: 3 }, { startTime: 3.1, endTime: 4 }, { startTime: 5, endTime: 6 }];
  assert.equal(conversationEnd(2, source), 4.12);
  assert.equal(conversationEnd(4.2, source), 4.2);
});

test('real generic action completion leaves video playing until the sentence ends, then updates the actual cursor', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const from = source.indexOf('function genericConversationEnd('), to = source.indexOf('\nfunction resetGameAtAction', from);
  const action = { actionId: 'chapter', endTime: 2 };
  const state = { sourceContext: { segments: [{ startTime: 1, endTime: 3 }] },
    analysis: { actions: [action], videoDuration: 10 }, consumedActionIds: new Set(),
    activeAction: action, currentActionIndex: -1, stopListener: () => {} };
  let pauses = 0, choices = 0;
  const video = { currentTime: 2, duration: 10, ended: false, pause: () => pauses++, removeEventListener() {} };
  const scope = { state, els: { video, choices: { classList: { add() {} } } },
    mediaClient: { conversationEndAt: (time, rows, duration) => conversationEnd(time, rows, [{ start: 1, end: 4 }], { dubEnabled: true, duration }) },
    conversationEnd, setGameState() {}, persistRuntimeSnapshot() {}, renderChoices: () => choices++ };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.finish = finishAction;', scope);
  scope.finish(action);
  assert.equal(pauses, 0); assert.equal(choices, 0); assert.equal(state.activeAction, action);
  video.currentTime = 4.15; scope.finish(action);
  assert.equal(pauses, 1); assert.equal(choices, 1); assert.equal(state.gameCursorTime, 4.15);
});
