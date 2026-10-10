const DATABASE = 'videoquest-analysis-responses';
const STORE = 'responses';
const VERSION = 'exact-analysis-response-v2-source-evidence';
const CHECKPOINT_VERSION = 'verified-chunk-v1';

export async function analysisRequestKey({ revision, path, form, headers, crypto = globalThis.crypto }) {
  if (!revision || !crypto?.subtle) return null;
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const encode = text => new TextEncoder().encode(text);
  const fields = [];
  for (const [name, value] of form) fields.push([name, typeof value === 'string'
    ? value : { type: value.type, size: value.size, digest: await digest(await value.arrayBuffer()) }]);
  // API keys are *credentials*, not scene evidence. Identical images, dialogue,
  // prompt and revision on this one browser must reuse verified results even
  // after the user rotates an exhausted Gemini key. Never store the key.
  return digest(encode(JSON.stringify([VERSION, revision, path, fields])));
}

export async function analysisCheckpointKey({ sheets, timestamps, duration, mode, crypto = globalThis.crypto } = {}) {
  if (!crypto?.subtle || !Array.isArray(sheets) || !sheets.length ||
      !Array.isArray(timestamps) || !Number.isFinite(Number(duration)) || !mode) return null;
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const proofs = [];
  // Hash all actual storyboard image bytes, not just a filename, URL or
  // claimed video duration. Re-selecting a different video cannot import
  // another video's game even if its superficial file metadata matches.
  for (const sheet of sheets) {
    if (!(sheet instanceof Blob) || sheet.size === 0) return null;
    proofs.push(await digest(await sheet.arrayBuffer()));
  }
  return digest(new TextEncoder().encode(JSON.stringify([
    CHECKPOINT_VERSION, Number(duration), timestamps, proofs, mode
  ])));
}

export function createAnalysisResponseCache({ indexedDB = globalThis.indexedDB, now = Date.now,
  ttlMs = 86400000, maxEntries = 64, maxCheckpoints = 128 } = {}) {
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
              const live = rows.filter(row => !row.checkpoint && row.expiresAt > now())
                .sort((a, b) => a.createdAt - b.createdAt);
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
    async readCheckpoint(prefix, chunkIndex) {
      if (!prefix || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) return null;
      const key = `checkpoint:${prefix}:${chunkIndex}`;
      return transaction('readonly', (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const row = request.result;
          done(row?.checkpoint && row.expiresAt > now() &&
            row.result?.available === true && Array.isArray(row.result.actions)
            ? structuredClone(row.result) : null);
        };
      }).catch(() => null);
    },
    async saveCheckpoint(prefix, chunkIndex, result) {
      if (!prefix || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
          result?.available !== true || !Array.isArray(result.actions)) return false;
      const key = `checkpoint:${prefix}:${chunkIndex}`;
      return transaction('readwrite', store => {
        const request = store.getAll();
        request.onsuccess = () => {
          const rows = request.result;
          for (const row of rows) if (row.expiresAt <= now()) store.delete(row.key);
          const live = rows.filter(row => row.checkpoint && row.key !== key && row.expiresAt > now())
            .sort((a, b) => a.createdAt - b.createdAt);
          while (live.length >= maxCheckpoints) store.delete(live.shift().key);
          store.put({ key, checkpoint: true, result: structuredClone(result),
            createdAt: now(), expiresAt: now() + ttlMs });
        };
      }).then(() => true).catch(() => false);
    },
    async close() { if (connection) (await connection).close(); connection = null; }
  };
}
