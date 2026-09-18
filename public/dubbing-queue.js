// One provider request at a time, but the current line takes precedence over
// speculative preload work. Keys deduplicate requests and can be promoted.
export function createDubRequestQueue() {
  const pending = new Map();
  let active = false;
  let scheduled = false;
  let sequence = 0;

  function schedule() {
    if (active || scheduled || !pending.size) return;
    scheduled = true;
    Promise.resolve().then(async () => {
      scheduled = false;
      if (active || !pending.size) return;
      const job = [...pending.values()].sort((a, b) =>
        b.priority - a.priority || a.sequence - b.sequence)[0];
      pending.delete(job.key);
      active = true;
      try { job.resolve(await job.run()); }
      catch (error) { job.reject(error); }
      finally { active = false; schedule(); }
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
