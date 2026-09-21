import { MAX_VIDEO_BYTES, MAX_MEMORY_VIDEO_BYTES } from './media-limits.js';

const DIRECTORY = 'videoquest-temporary-downloads';
const WRITE_BATCH_BYTES = 1024 * 1024;
const lockName = name => `${DIRECTORY}:${name}`;
const storageError = () => Object.assign(new Error('Video için cihazda yeterli boş depolama alanı yok. Yer açıp tekrar dene.'), { code: 'VIDEO_STORAGE_FULL' });
const directError = () => Object.assign(new Error('Video doğrudan tarayıcıya indirilemedi. Kaynak erişimi engelliyor veya bağlantı yanıt vermiyor olabilir. Videoyu tarayıcıda açıp indir, ardından cihazından seç.'), { code: 'DIRECT_VIDEO_BLOCKED' });

export function createVideoDownloader({
  fetch: fetchVideo = (...args) => globalThis.fetch(...args),
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks
} = {}) {
  const owners = new WeakMap();
  let directoryPromise;

  async function directory() {
    if (!storage?.getDirectory || !locks?.request) return null;
    if (!directoryPromise) directoryPromise = (async () => {
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIRECTORY, { create: true });
      // Only abandoned temporary files are removed. Active tabs hold a lock for
      // the entire File lifetime; saved games live in a separate IndexedDB store.
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind !== 'file' || !/^download-[\w-]+$/.test(name)) continue;
        await locks.request(lockName(name), { ifAvailable: true }, async lock => {
          if (lock) await dir.removeEntry(name).catch(() => {});
        });
      }
      return dir;
    })().catch(error => {
      directoryPromise = null;
      if (error.name === 'QuotaExceededError') throw storageError();
      return null; // Older/private browsers retain the bounded Blob fallback.
    });
    return directoryPromise;
  }

  async function hold(name) {
    let unlock;
    let acquired;
    let failed;
    const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
    const held = locks.request(lockName(name), () => new Promise(resolve => {
      unlock = resolve;
      acquired();
    }));
    held.catch(failed);
    await ready;
    return async () => { unlock(); await held; };
  }

  async function release(blob) {
    const dispose = owners.get(blob);
    owners.delete(blob);
    if (dispose) await dispose();
  }

  function adopt(blob, file) {
    const dispose = owners.get(blob);
    if (dispose) { owners.delete(blob); owners.set(file, dispose); }
    return file;
  }

  async function transfer(url, options = {}) {
    const controller = new AbortController();
    const requestedLimit = Math.min(MAX_VIDEO_BYTES, Math.max(1, Number(options.maxBytes) || MAX_VIDEO_BYTES));
    let maxBytes = requestedLimit;
    let reader, response, writer, dir, name, unlock;
    let idleTimer, totalTimer, headerTimer;
    let stage = 'network';
    let writeMs = 0;
    let retained = false;
    const abort = () => controller.abort(options.signal?.reason);
    const checkpoint = () => controller.signal.throwIfAborted();
    const refreshDeadline = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), 45000);
    };
    const sizeError = () => Object.assign(new Error(maxBytes < requestedLimit
      ? 'Bu tarayıcı büyük dosyaları doğrudan depolamaya yazamıyor; bellekten indirme sınırı 600 MB. Güncel Chrome/Safari kullan veya videoyu cihazından seç.'
      : `Video ${Math.round(maxBytes / 1024 / 1024)} MB indirme sınırını aşıyor.`), { code: 'VIDEO_SIZE_LIMIT' });
    const dispose = async () => {
      try { if (name) await dir.removeEntry(name); } catch {}
      finally { if (unlock) { await unlock(); unlock = null; } }
    };
    try {
      if (options.signal?.aborted) abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.maxDurationMs > 0) totalTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
      refreshDeadline();
      checkpoint();
      const headerWait = options.directOnly ? 12000 : 4000;
      if (options.direct) headerTimer = setTimeout(() => controller.abort(), Math.min(headerWait, options.directHeaderTimeoutMs || headerWait));
      response = await fetchVideo(url, { signal: controller.signal,
        ...(options.direct ? { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' } : {}) });
      clearTimeout(headerTimer);
      if (!response.ok) {
        if (options.direct) throw new Error(`Doğrudan video aktarımı kullanılamıyor (${response.status}).`);
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `Video indirilemedi (${response.status}).`);
      }
      const declaredTotal = Number(response.headers.get('content-length')) || 0;
      const expectedTotal = Math.max(0, Number(options.expectedSize) || 0);
      if (expectedTotal && declaredTotal && expectedTotal !== declaredTotal) throw new Error('Video kaynak boyutu değişti. Bağlantıyı yeniden aç.');
      const total = declaredTotal || expectedTotal;
      const contentType = response.headers.get('content-type') || 'video/mp4';
      if (options.direct && (response.status !== 200 || !/^(?:video\/|application\/octet-stream|binary\/octet-stream)/i.test(contentType))) {
        throw new Error('Kaynak doğrudan video aktarımını desteklemiyor.');
      }
      if (total > maxBytes) throw sizeError();
      stage = 'storage';
      dir = await directory();
      checkpoint();
      if (dir) {
        let estimate;
        try { estimate = await storage.estimate?.(); } catch {}
        if (total && estimate?.quota > 0 && total > estimate.quota - (estimate.usage || 0)) throw storageError();
        name = `download-${crypto.randomUUID()}`;
        unlock = await hold(name);
        checkpoint();
        const handle = await dir.getFileHandle(name, { create: true });
        // A bounded buffer below batches network packets into larger writes.
        try { writer = await handle.createWritable(); }
        catch (error) {
          if (!['NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(error.name) && typeof handle.createWritable === 'function') throw error;
          await dispose();
          name = null;
          dir = null;
        }
      }
      if (!writer) maxBytes = Math.min(requestedLimit, MAX_MEMORY_VIDEO_BYTES);
      if (total > maxBytes) throw sizeError();
      stage = 'network';
      reader = response.body?.getReader();
      if (!reader) throw new Error('Tarayıcı video akışını okuyamadı. Güncel bir tarayıcıyla tekrar dene.');
      const chunks = [];
      let pending = [];
      let pendingBytes = 0;
      const write = async value => {
        stage = 'storage';
        const started = Date.now();
        await writer.write(value);
        writeMs += Date.now() - started;
        checkpoint();
      };
      const flush = async () => {
        if (!pendingBytes) return;
        let data = pending[0];
        if (pending.length > 1) {
          data = new Uint8Array(pendingBytes);
          let offset = 0;
          for (const part of pending) { data.set(part, offset); offset += part.byteLength; }
        }
        await write(data);
        pending = [];
        pendingBytes = 0;
      };
      let received = 0;
      let lastReport = -Infinity;
      const report = (force = false) => {
        const now = Date.now();
        if (force || now - lastReport >= 200) {
          lastReport = now;
          options.onProgress?.({ loaded: received, total, transport: options.direct ? 'direct' : 'proxy', writeMs });
        }
      };
      while (true) {
        checkpoint();
        stage = 'network';
        const { done, value } = await reader.read();
        checkpoint();
        if (done) break;
        received += value.byteLength ?? value.length;
        if (received > maxBytes) throw sizeError();
        refreshDeadline();
        if (writer) {
          if (value.byteLength >= WRITE_BATCH_BYTES) { await flush(); await write(value); }
          else {
            pending.push(value);
            pendingBytes += value.byteLength;
            if (pendingBytes >= WRITE_BATCH_BYTES) await flush();
          }
        }
        else chunks.push(value);
        checkpoint();
        refreshDeadline();
        report();
      }
      if (!received) throw new Error('Video boş geldi.');
      if (total && received !== total) throw new Error('Video aktarımı eksik kaldı. Bağlantıyı kontrol edip tekrar dene.');
      let blob;
      if (writer) {
        await flush();
        stage = 'storage';
        await writer.close();
        writer = null;
        checkpoint();
        const file = await (await dir.getFileHandle(name)).getFile();
        if (file.size !== received) throw new Error('Video cihaz depolamasına eksik yazıldı. Tekrar dene.');
        blob = file.slice(0, file.size, contentType);
        report(true);
        checkpoint();
        owners.set(blob, dispose);
        retained = true;
      } else {
        blob = new Blob(chunks, { type: contentType });
        report(true);
        checkpoint();
      }
      return blob;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (error.name === 'QuotaExceededError') throw storageError();
      if (controller.signal.aborted) error = new Error('Video aktarımı durdu. Bağlantını kontrol edip tekrar dene.');
      if (options.direct && stage === 'network' && !error.code) error.retryViaProxy = true;
      throw error;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearTimeout(headerTimer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      if (writer) { try { await writer.abort(); } catch {} }
      if (!retained) await dispose();
    }
  }
  async function download(url, options = {}) {
    const started = Date.now();
    let directUrl;
    try {
      const candidate = new URL(options.directUrl);
      if (candidate.protocol === 'https:' && !candidate.username && !candidate.password &&
          !/\.(?:m3u8|mpd)(?:$|[?#])/i.test(candidate.href)) directUrl = candidate.href;
    } catch {}
    if (options.directOnly && !directUrl) throw directError();
    if (directUrl) {
      try { return await transfer(directUrl, { ...options, direct: true }); }
      catch (error) {
        if (options.signal?.aborted || !error.retryViaProxy) throw error;
        if (options.directOnly) throw directError();
        if (options.maxDurationMs > 0 && Date.now() - started >= options.maxDurationMs) throw error;
        options.onProgress?.({ loaded: 0, total: options.expectedSize || 0, transport: 'proxy', writeMs: 0 });
      }
    }
    return transfer(url, { ...options, direct: false,
      maxDurationMs: options.maxDurationMs > 0 ? Math.max(1, options.maxDurationMs - (Date.now() - started)) : 0 });
  }
  return { download, adopt, release };
}
