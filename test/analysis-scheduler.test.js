import test from 'node:test';
import assert from 'node:assert/strict';
import { runContextualAnalysisChunks } from '../public/analysis-scheduler.js';

test('first chapter locks context, then later chapters run in bounded pairs', async () => {
  const starts = [], snapshots = [], completed = [];
  let active = 0, maximum = 0;
  const stopped = await runContextualAnalysisChunks(5, {
    context: () => completed.join(','),
    analyze: async (index, snapshot) => {
      starts.push(index);
      snapshots[index] = snapshot;
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, index === 1 ? 8 : 1));
      active--;
      return { chunkIndex: index, result: { profile: index === 0 ? 'locked' : null } };
    },
    afterBatch: batch => completed.push(...batch.map(result => result.chunkIndex))
  });
  assert.equal(stopped, null);
  assert.equal(maximum, 2);
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  assert.deepEqual(snapshots, ['', '0', '0', '0,1,2', '0,1,2']);
  assert.deepEqual(completed, [0, 1, 2, 3, 4]);
});

test('a failed pair preserves its completed sibling and does not start the next batch', async () => {
  const started = [], saved = [];
  const stopped = await runContextualAnalysisChunks(6, {
    context: () => saved.length,
    analyze: async index => {
      started.push(index);
      return index === 2 ? { chunkIndex: index, failureBody: { reason: 'provider' } }
        : { chunkIndex: index, result: { available: true } };
    },
    afterBatch: batch => saved.push(...batch.filter(item => item.result).map(item => item.chunkIndex))
  });
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(saved, [0, 1]);
  assert.equal(stopped.chunkIndex, 2);
});
