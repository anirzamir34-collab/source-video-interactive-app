import test from 'node:test';
import assert from 'node:assert/strict';
import { createDubRequestQueue } from '../public/dubbing-queue.js';

test('equal-priority jobs stay serial and stable; a failed job does not stall the queue', async () => {
  const queue = createDubRequestQueue();
  const calls = [];
  let active = 0;
  const job = id => async () => {
    assert.equal(active++, 0);
    calls.push(id);
    await Promise.resolve();
    active--;
    if (id === 'bad') throw new Error('test failure');
    return id;
  };
  const results = await Promise.allSettled(['one', 'bad', 'three'].map(id => queue.enqueue(id, job(id))));
  assert.deepEqual(calls, ['one', 'bad', 'three']);
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('a seek demotes old urgent work and the next selected timestamp gets priority', async () => {
  const queue = createDubRequestQueue();
  const calls = [];
  const old = queue.enqueue('old', () => calls.push('old'), 100);
  queue.deprioritize();
  const current = queue.enqueue('current', () => calls.push('current'), 50);
  await Promise.all([old, current]);
  assert.deepEqual(calls, ['current', 'old']);
});

test('reset resolves pending work without invoking it', async () => {
  const queue = createDubRequestQueue();
  const pending = queue.enqueue('old', () => assert.fail('reset work must not start'));
  queue.clear();
  assert.equal(await pending, null);
  assert.equal(await queue.enqueue('new', () => 'ready'), 'ready');
});

test('repeated queued keys reuse their promise and promotion never lowers priority', async () => {
  const queue = createDubRequestQueue();
  const calls = [];
  const first = queue.enqueue('one', () => calls.push('one'), 20);
  const same = queue.enqueue('one', () => assert.fail('duplicate'), 0);
  queue.promote('one', 0);
  const second = queue.enqueue('two', () => calls.push('two'), 10);
  assert.equal(same, first);
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['one', 'two']);
});
