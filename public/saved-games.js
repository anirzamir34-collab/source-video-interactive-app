// Store media separately so opening the shelf never reads every video into memory.
const DATABASE = 'videoquest-saved-games';
const STORES = ['games', 'payloads', 'videos'];
const MAGIC = 'VQGAME1\n';
const MAX_HEADER = 128 * 1024 * 1024;
const secretField = /^(?:api[_-]?key|.*ApiKey|authorization|password|access[_-]?token|refresh[_-]?token|proxyUrl|sourceUrl|__proto__|constructor|prototype)$/i;

function cleanJson(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => secretField.test(key) ? undefined : item));
}

export function validateGame(game) {
  if (!game || game.version !== 1) throw new Error('Bu kayıt biçimi desteklenmiyor.');
  if (!(game.video instanceof Blob) || !game.video.size) throw new Error('Kayıtta video dosyası eksik.');
  if (!Number.isFinite(game.duration) || game.duration <= 0) throw new Error('Kayıt süresi geçersiz.');
  const p = game.payload;
  if (!p || (!p.analysis && !p.dialogue)) throw new Error('Kayıtta analiz bulunamadı.');
  if (p.analysis && (!Array.isArray(p.analysis.actions) || !p.analysis.actions.length)) {
    throw new Error('Kayıttaki oyun analizi geçersiz.');
  }
  if (p.dialogue && !Array.isArray(p.dialogue.segments)) throw new Error('Kayıttaki diyalog geçersiz.');
  for (const pair of [p.dubCache || [], p.dubStableSpeakerGenders || []]) {
    if (!Array.isArray(pair) || pair.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string')) {
      throw new Error('Kayıttaki ses bilgileri geçersiz.');
    }
  }
  if ((p.dubCache || []).some(([, value]) => !/^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(value))) {
    throw new Error('Kayıtta geçersiz dublaj sesi var.');
  }
  return game;
}

export function prepareGame(input, previous = null) {
  const now = new Date().toISOString();
  const game = {
    version: 1,
    id: previous?.id || crypto.randomUUID(),
    title: String(input.title || input.fileName || 'Kayıtlı oyun').trim().slice(0, 120) || 'Kayıtlı oyun',
    fileName: String(input.fileName || 'video.mp4').slice(0, 240),
    sourceKind: input.sourceKind === 'url' ? 'url' : 'file',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    duration: Number(input.duration),
    video: input.video,
    // Explicit allowlist: never copy API credentials, remote URLs or session state.
    payload: cleanJson({
      analysis: input.payload?.analysis || null,
      dialogue: input.payload?.dialogue || null,
      dubCache: input.payload?.dubCache || [],
      dubVoiceIds: input.payload?.dubVoiceIds || {},
      dubStableSpeakerGenders: input.payload?.dubStableSpeakerGenders || [],
      subtitlesEnabled: Boolean(input.payload?.subtitlesEnabled),
      dubbingEnabled: Boolean(input.payload?.dubbingEnabled),
      keepOriginalAudioEnabled: input.payload?.keepOriginalAudioEnabled !== false
    })
  };
  return validateGame(game);
}

function summary(game) {
  const { video, payload, ...meta } = game;
  return {
    ...meta, videoBytes: video.size,
    totalBytes: video.size + new Blob([JSON.stringify(payload)]).size,
    actionCount: payload.analysis?.actions.length || 0,
    dialogueCount: payload.dialogue?.segments.length || 0,
    dubCount: payload.dubCache.length
  };
}

export function createGameStore({ indexedDB = globalThis.indexedDB, database = DATABASE } = {}) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('Bu tarayıcı cihazda kayıt tutmayı desteklemiyor.')); return; }
      const request = indexedDB.open(database, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onblocked = () => { settled = true; reject(new Error('Kaydı açmak için uygulamanın diğer sekmelerini kapat.')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  async function transaction(stores, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Kayıt işlemi tamamlanamadı.'));
      tx.onerror = () => {}; // Abort is the final result; no partial success.
      const fail = error => { tx.abort(); reject(error); };
      try { operation(tx, value => { result = value; }, fail); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    async list() {
      const rows = await transaction(['games'], 'readonly', (tx, done) => {
        const request = tx.objectStore('games').getAll();
        request.onsuccess = () => done(request.result);
      });
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(input, existingId = null) {
      const game = prepareGame(input);
      const meta = summary(game);
      return transaction(STORES, 'readwrite', (tx, done, fail) => {
        const write = previous => {
          try {
            if (previous) { meta.id = previous.id; meta.createdAt = previous.createdAt; }
            tx.objectStore('games').put(meta);
            tx.objectStore('payloads').put({ id: meta.id, payload: game.payload });
            tx.objectStore('videos').put({ id: meta.id, video: game.video });
            done(meta);
          } catch (error) { fail(error); }
        };
        if (!existingId) write(null);
        else {
          const request = tx.objectStore('games').get(existingId);
          request.onsuccess = () => write(request.result);
        }
      });
    },
    async load(id) {
      const game = await transaction(STORES, 'readonly', (tx, done) => {
        const results = {};
        let pending = STORES.length;
        for (const store of STORES) {
          const request = tx.objectStore(store).get(id);
          request.onsuccess = () => {
            results[store] = request.result;
            if (!--pending) done({ ...results.games, payload: results.payloads?.payload, video: results.videos?.video });
          };
        }
      });
      validateGame(game);
      if (game.video.size !== game.videoBytes) throw new Error('Kayıttaki video eksik veya bozuk.');
      return game;
    },
    remove(id) {
      return transaction(STORES, 'readwrite', tx => { for (const store of STORES) tx.objectStore(store).delete(id); });
    },
    async close() { if (connection) (await connection).close(); connection = null; }
  };
}

// Video bytes are appended directly, without a base64 copy of the video.
export function exportGame(input) {
  const game = prepareGame(input);
  const { video, ...metadata } = game;
  const header = new TextEncoder().encode(JSON.stringify({ ...metadata, videoSize: video.size, videoType: video.type }));
  if (header.byteLength > MAX_HEADER) throw new Error('Dublaj verisi yedek dosyası için çok büyük. Cihazdaki kayıt korunuyor.');
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength);
  return new Blob([MAGIC, length, header, video], { type: 'application/octet-stream' });
}

export async function importGame(file) {
  if (!(file instanceof Blob) || file.size < 12) throw new Error('Geçerli bir .vqgame yedeği seç.');
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(prefix.slice(0, 8)) !== MAGIC) throw new Error('Bu dosya bir oyun yedeği değil.');
  const size = new DataView(prefix.buffer).getUint32(8);
  if (!size || size > MAX_HEADER || 12 + size >= file.size) throw new Error('Yedek dosyası eksik veya bozuk.');
  let header;
  try { header = JSON.parse(await file.slice(12, 12 + size).text()); }
  catch { throw new Error('Yedek bilgileri okunamadı.'); }
  if (header?.version !== 1 || !Number.isSafeInteger(header.videoSize) || header.videoSize <= 0 || file.size !== 12 + size + header.videoSize) {
    throw new Error('Yedek sürümü veya video boyutu geçersiz.');
  }
  if (typeof header.videoType !== 'string' || !/^(?:video\/[\w.+-]+|application\/octet-stream)?$/.test(header.videoType)) {
    throw new Error('Yedekteki dosya bir video değil.');
  }
  // Imported IDs cannot overwrite another saved game.
  return prepareGame({ ...header, video: file.slice(12 + size, file.size, header.videoType) });
}

export function storageError(error) {
  if (error?.name === 'QuotaExceededError') return 'Cihazda yeterli boş alan yok. Oyun kaydedilemedi; mevcut kayıtların silinmedi. Alan açıp “Şimdi kaydet” ile tekrar dene veya “Yedek indir” ile dosyaya kaydet.';
  return `Kayıt işlemi tamamlanamadı: ${error?.message || 'Tarayıcı depolaması kullanılamıyor.'}`;
}
