import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisProgress } from '../public/analysis-progress.js';

function progress() {
  return createAnalysisProgress({ setTimer: () => 1, clearTimer: () => {} });
}
const row = (view, id) => view.snapshot().find(item => item.id === id);

test('source transcript readiness does not mark future dubbing or visual analysis complete', () => {
  const view = progress();
  view.begin({ motion: true, dubbing: true, subtitles: false });
  view.observe({ state: 'READY', transcriptOnly: true, origin: 'server' });
  assert.equal(row(view, 'transcript').status, 'done');
  for (const id of ['analysis', 'translation', 'dub', 'align', 'save'])
    assert.equal(row(view, id).status, 'pending');
  view.finish('cancelled');
});

test('provider waiting carries no invented percentage while parallel frame preparation continues', () => {
  const view = progress();
  view.begin({ motion: true });
  view.update('frames', { loaded: 7, total: 20, unit: 'kare' });
  view.observe({ state: 'TRANSCRIBING', origin: 'server', waiting: true, progress: 15,
    lastServerContactAt: 100, message: 'Scribe yanıtı bekleniyor.' });
  assert.equal(row(view, 'transcript').status, 'waiting');
  assert.equal(row(view, 'transcript').loaded, undefined);
  assert.equal(row(view, 'transcript').total, undefined);
  assert.equal(row(view, 'frames').loaded, 7);
  assert.equal(row(view, 'frames').status, 'working');
  view.finish('cancelled');
});

test('completed server stages and measured speech counts remain distinct from current work', () => {
  const view = progress();
  view.begin({ motion: false });
  view.observe({ state: 'ALIGNING', origin: 'server',
    completedStages: ['TRANSLATING', 'ASSIGNING_VOICES', 'GENERATING_DUB'],
    stageProgress: { loaded: 3, total: 8, unit: 'konuşma' } });
  assert.equal(row(view, 'dub').status, 'done');
  assert.equal(row(view, 'align').status, 'working');
  assert.equal(row(view, 'align').loaded, 3); assert.equal(row(view, 'align').total, 8);
  view.observe({ state: 'CANCELLED', message: 'Kullanıcı iptal etti.' });
  assert.equal(row(view, 'align').status, 'cancelled');
  assert.equal(row(view, 'dub').status, 'done');
});
