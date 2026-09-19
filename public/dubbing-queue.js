// A small bounded provider pool keeps preparation moving without creating a
// rate-limit burst. The current line still takes precedence over speculative
// preload work; keys remain deduplicated and promotable.
export function createDubRequestQueue(maxConcurrent = 1) {
  const pending = new Map();
  const limit = Math.max(1, Math.min(2, Math.floor(Number(maxConcurrent) || 1)));
  let activeCount = 0;
  let scheduled = false;
  let sequence = 0;

  function schedule() {
    if (activeCount >= limit || scheduled || !pending.size) return;
    scheduled = true;
    Promise.resolve().then(async () => {
      scheduled = false;
      if (activeCount >= limit || !pending.size) return;
      const job = [...pending.values()].sort((a, b) =>
        b.priority - a.priority || a.sequence - b.sequence)[0];
      pending.delete(job.key);
      activeCount += 1;
      schedule();
      try { job.resolve(await job.run()); }
      catch (error) { job.reject(error); }
      finally { activeCount -= 1; schedule(); }
    });
  }

  return {
    enqueue(key, run, priority = 0) {
      const existing = pending.get(key);
      if (existing) {
        existing.priority = Math.max(existing.priority, priority);
        return existing.promise;
      }
      let resolve, reject;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      pending.set(key, { key, run, priority, sequence: sequence++, promise, resolve, reject });
      schedule();
      return promise;
    },
    promote(key, priority) {
      const job = pending.get(key);
      if (job) job.priority = Math.max(job.priority, priority);
    },
    deprioritize() {
      for (const job of pending.values()) job.priority = 0;
    },
    clear() {
      for (const job of pending.values()) job.resolve(null);
      pending.clear();
    }
  };
}
