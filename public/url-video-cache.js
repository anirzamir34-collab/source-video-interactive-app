const DATABASE = 'videoquest-url-video-cache';
const STORE = 'videos';
export const URL_VIDEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function createUrlVideoCache({
  indexedDB = globalThis.indexedDB,
  now = () => Date.now(),
  ttlMs = URL_VIDEO_CACHE_TTL_MS
} = {}) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      if (!indexedDB) {
        reject(new Error('Bu tarayıcı 24 saatlik video önbelleğini desteklemiyor.'));
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Video önbelleğini açmak için diğer uygulama sekmelerini kapat.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    }).catch(error => {
      connection = null;
      throw error;
    });
    return connection;
  }
  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Video önbelleği işlemi tamamlanamadı.'));
      tx.onerror = () => {};
      try { operation(tx.objectStore(STORE), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async function remove(key) {
    if (!key) return;
    await transaction('readwrite', store => store.delete(String(key)));
  }
  async function removeExpired() {
    const cutoff = now();
    await transaction('readwrite', store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!Number.isFinite(Number(cursor.value?.expiresAt)) || Number(cursor.value.expiresAt) <= cutoff) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }
  async function get(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    const row = await transaction('readonly', (store, done) => {
      const request = store.get(normalizedKey);
      request.onsuccess = () => done(request.result || null);
    });
    if (!row) return null;
    if (!(row.video instanceof Blob) || !row.video.size ||
        !Number.isFinite(Number(row.expiresAt)) || Number(row.expiresAt) <= now()) {
      await remove(normalizedKey).catch(() => {});
      return null;
    }
    const fileName = String(row.fileName || 'url-video.mp4').slice(0, 240);
    const type = String(row.type || row.video.type || 'video/mp4');
    const file = row.video instanceof File && row.video.name === fileName
      ? row.video
      : new File([row.video], fileName, { type, lastModified: Number(row.createdAt) || now() });
    return {
      key: normalizedKey,
      file,
      audioReuseToken: String(row.audioReuseToken || ''),
      createdAt: Number(row.createdAt) || 0,
      expiresAt: Number(row.expiresAt)
    };
  }
  async function put(key, file, { audioReuseToken = '' } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || !(file instanceof Blob) || !file.size) {
      throw new Error('Önbelleğe alınacak URL videosu geçersiz.');
    }
    const createdAt = now();
    const row = {
      key: normalizedKey,
      video: file,
      fileName: String(file.name || 'url-video.mp4').slice(0, 240),
      type: String(file.type || 'video/mp4'),
      size: file.size,
      createdAt,
      expiresAt: createdAt + ttlMs,
      audioReuseToken: String(audioReuseToken || '')
    };
    await transaction('readwrite', (store, done) => {
      store.put(row);
      done(row);
    });
    return row;
  }
  async function update(key, { audioReuseToken } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return false;
    return transaction('readwrite', (store, done) => {
      const request = store.get(normalizedKey);
      request.onsuccess = () => {
        const row = request.result;
        if (!row || Number(row.expiresAt) <= now()) {
          if (row) store.delete(normalizedKey);
          done(false);
          return;
        }
        if (audioReuseToken !== undefined) row.audioReuseToken = String(audioReuseToken || '');
        store.put(row);
        done(true);
      };
    });
  }
  async function close() {
    if (connection) (await connection).close();
    connection = null;
  }
  return { get, put, update, remove, removeExpired, close };
}
