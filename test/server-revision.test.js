import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerRevisionReader } from '../public/server-revision.js';

test('health revision is shared and expires so deployments invalidate response keys', async () => {
  let time = 0, calls = 0;
  const read = createServerRevisionReader({ now: () => time, fetch: async () => {
    calls++; return new Response(JSON.stringify({ analysisRevision: `revision-${calls}` }));
  } });
  assert.deepEqual(await Promise.all([read(), read()]), ['revision-1', 'revision-1']);
  time = 29999; assert.equal(await read(), 'revision-1'); assert.equal(calls, 1);
  time = 30000; assert.equal(await read(), 'revision-2'); assert.equal(calls, 2);
});

test('a failed health lookup is retried rather than reusing an expired revision', async () => {
  let calls = 0, time = 0;
  const read = createServerRevisionReader({ now: () => time, fetch: async () => {
    calls++;
    if (calls === 2) throw Error('offline');
    if (calls === 3) return new Response('{}');
    return new Response(JSON.stringify({ analysisRevision: `revision-${calls}` }));
  } });
  await read(); time = 30000;
  await assert.rejects(read(), /offline/);
  assert.equal(await read(), null);
  assert.equal(await read(), 'revision-4');
});

test('canceling one caller does not cancel the shared health lookup', async () => {
  let finish;
  const read = createServerRevisionReader({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  const canceled = read({ signal: controller.signal });
  const active = read();
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  finish(new Response(JSON.stringify({ analysisRevision: 'shared' })));
  assert.equal(await active, 'shared');
});
