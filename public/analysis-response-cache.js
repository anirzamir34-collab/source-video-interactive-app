const DATABASE = 'videoquest-analysis-responses';
const STORE = 'responses';
const VERSION = 'exact-analysis-response-v1';

export async function analysisRequestKey({ revision, path, form, headers, crypto = globalThis.crypto }) {
  if (!revision || !crypto?.subtle) return null;
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const encode = text => new TextEncoder().encode(text);
  const fields = [];
  for (const [name, value] of form) fields.push([name, typeof value === 'string'
    ? value : { type: value.type, size: value.size, digest: await digest(await value.arrayBuffer()) }]);
  // File names are upload labels, not evidence. Everything the model actually
  // reads, the revision, and the account scope participate in the identity.
  return digest(encode(JSON.stringify([VERSION, revision, path,
    new Headers(headers).get('x-analysis-provider') || 'gemini',
    new Headers(headers).get('x-cloudflare-account-id') || '',
    new Headers(headers).get('x-cloudflare-api-token') || new Headers(headers).get('x-gemini-api-key') || 'server', fields])));
}

export function createAnalysisResponseCache({ indexedDB = globalThis.indexedDB, now = Date.now,
  ttlMs = 86400000, maxEntries = 64 } = {}) {
  let connection;
  const pending = new Map();
  async function open() {
    if (!connection) connection = new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('Analysis cache unavailable'));
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Analysis cache blocked'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Analysis cache transaction aborted'));
      tx.onerror = () => {};
      work(tx.objectStore(STORE), value => { result = value; });
    });
  }
  function reused(result, outcome) {
    const copy = structuredClone(result);
    copy.body.aiUsage = { requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, cacheHits: 1 };
    return { ...copy, outcome };
  }
  return {
    async run(key, load, { signal } = {}) {
      signal?.throwIfAborted();
      if (!key) return load();
      const row = await transaction('readonly', (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => done(request.result);
      }).catch(() => null);
      signal?.throwIfAborted();
      if (row?.expiresAt > now() && row.result?.status === 200 && row.result.body?.available === true)
        return reused(row.result, 'cache_hit');
      if (pending.has(key)) {
        const result = await pending.get(key);
        signal?.throwIfAborted();
        return result.status === 200 && result.body?.available === true ? reused(result, 'shared_result') : result;
      }
      const task = Promise.resolve().then(load).then(async result => {
        if (result.status === 200 && result.body?.available === true && Array.isArray(result.body.actions)) {
          await transaction('readwrite', store => {
            const request = store.getAll();
            request.onsuccess = () => {
              const rows = request.result.filter(row => row.key !== key);
              const live = rows.filter(row => row.expiresAt > now()).sort((a, b) => a.createdAt - b.createdAt);
              for (const row of rows) if (row.expiresAt <= now()) store.delete(row.key);
              while (live.length >= maxEntries) store.delete(live.shift().key);
              store.put({ key, result, createdAt: now(), expiresAt: now() + ttlMs });
            };
          }).catch(() => {}); // Storage restrictions never block analysis.
        }
        return result;
      });
      pending.set(key, task);
      try { const result = await task; signal?.throwIfAborted(); return result; }
      finally { if (pending.get(key) === task) pending.delete(key); }
    },
    async close() { if (connection) (await connection).close(); connection = null; }
  };
}

