import crypto from 'node:crypto';

// Hash the complete request, including account and model. Never retain keys or
// images in cache entries; only successful parsed results are reusable.
export function storyboardRequestKey({ apiKey, model, prompt, files, generationConfig = {} }) {
  const hash = crypto.createHash('sha256');
  for (const value of [apiKey, model, JSON.stringify(generationConfig), prompt, ...files.flatMap(file => [file.mimetype || 'image/jpeg', file.buffer])]) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    hash.update(String(bytes.length)).update(':').update(bytes);
  }
  return hash.digest('hex');
}

export function createAnalysisRequestCache({ now = Date.now, ttlMs = 86400000, maxEntries = 96 } = {}) {
  const ready = new Map(), pending = new Map();
  return {
    async run(key, generate) {
      for (const [id, row] of ready) if (row.expiresAt <= now()) ready.delete(id);
      const cached = ready.get(key);
      if (cached) return { value: structuredClone(cached.value), outcome: 'cache_hit' };
      if (pending.has(key)) return { value: structuredClone(await pending.get(key)), outcome: 'shared_result' };
      const task = Promise.resolve().then(generate).then(value => {
        const copy = structuredClone(value);
        ready.set(key, { value: copy, expiresAt: now() + ttlMs });
        while (ready.size > maxEntries) ready.delete(ready.keys().next().value);
        return copy;
      });
      pending.set(key, task);
      try { return { value: structuredClone(await task), outcome: 'completed' }; }
      finally { if (pending.get(key) === task) pending.delete(key); }
    }
  };
}
