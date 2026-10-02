function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('The queued task was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Limit asynchronous work without freeing an active slot before its task settles.
 * run(task, { signal }) invokes task(signal); active cancellation belongs to task.
 */
export function createLimiter(concurrency) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive safe integer.');
  }

  const queue = [];
  let activeCount = 0;
  let draining = false;

  function finish(entry, succeeded, result) {
    activeCount -= 1;
    entry.state = 'settled';
    if (succeeded) entry.resolve(result);
    else entry.reject(result);
    drain();
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (activeCount < concurrency && queue.length > 0) {
        const entry = queue.shift();
        entry.signal?.removeEventListener('abort', entry.onAbort);
        if (entry.signal?.aborted) {
          entry.state = 'settled';
          entry.reject(abortReason(entry.signal));
          continue;
        }

        entry.state = 'active';
        activeCount += 1;
        let result;
        try {
          result = entry.task(entry.signal);
        } catch (error) {
          finish(entry, false, error);
          continue;
        }
        Promise.resolve(result).then(
          value => finish(entry, true, value),
          error => finish(entry, false, error),
        );
      }
    } finally {
      draining = false;
    }
  }

  function run(task, { signal } = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task must be a function.'));
    }
    if (signal !== undefined && (
      signal === null
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function'
      || typeof signal.aborted !== 'boolean'
    )) {
      return Promise.reject(new TypeError('signal must be an AbortSignal.'));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const promise = new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, state: 'queued', onAbort: null };
      entry.onAbort = () => {
        if (entry.state !== 'queued') return;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        entry.state = 'settled';
        signal.removeEventListener('abort', entry.onAbort);
        reject(abortReason(signal));
        drain();
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      queue.push(entry);
      drain();
    });
    return promise;
  }

  return {
    run,
    get activeCount() { return activeCount; },
    get pendingCount() { return queue.length; },
    concurrency,
  };
}
