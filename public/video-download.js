import { MAX_VIDEO_BYTES, MAX_MEMORY_VIDEO_BYTES } from './media-limits.js';

const DIRECTORY = 'videoquest-temporary-downloads';
const lockName = name => `${DIRECTORY}:${name}`;
const storageError = () => new Error('Video için cihazda yeterli boş depolama alanı yok. Yer açıp tekrar dene.');

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

  async function download(url, options = {}) {
    const controller = new AbortController();
    const requestedLimit = Math.min(MAX_VIDEO_BYTES, Math.max(1, Number(options.maxBytes) || MAX_VIDEO_BYTES));
    let maxBytes = requestedLimit;
    let reader, response, writer, dir, name, unlock;
    let idleTimer, totalTimer;
    let retained = false;
    const abort = () => controller.abort(options.signal?.reason);
    const checkpoint = () => controller.signal.throwIfAborted();
    const refreshDeadline = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), 45000);
    };
    const sizeError = () => new Error(maxBytes < requestedLimit
      ? 'Bu tarayıcı büyük dosyaları doğrudan depolamaya yazamıyor; bellekten indirme sınırı 600 MB. Güncel Chrome/Safari kullan veya videoyu cihazından seç.'
      : `Video ${Math.round(maxBytes / 1024 / 1024)} MB indirme sınırını aşıyor.`);
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
      response = await fetchVideo(url, { signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `Video indirilemedi (${response.status}).`);
      }
      const total = Number(response.headers.get('content-length')) || 0;
      const contentType = response.headers.get('content-type') || 'video/mp4';
      if (total > maxBytes) throw sizeError();
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
        // Backpressure: each chunk reaches storage before the next is read.
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
      reader = response.body?.getReader();
      if (!reader) throw new Error('Tarayıcı video akışını okuyamadı. Güncel bir tarayıcıyla tekrar dene.');
      const chunks = [];
      let received = 0;
      while (true) {
        checkpoint();
        const { done, value } = await reader.read();
        checkpoint();
        if (done) break;
        received += value.byteLength ?? value.length;
        if (received > maxBytes) throw sizeError();
        refreshDeadline();
        if (writer) await writer.write(value);
        else chunks.push(value);
        checkpoint();
        refreshDeadline();
        options.onProgress?.({ loaded: received, total });
      }
      if (!received) throw new Error('Video boş geldi.');
      if (total && received !== total) throw new Error('Video aktarımı eksik kaldı. Bağlantıyı kontrol edip tekrar dene.');
      let blob;
      if (writer) {
        await writer.close();
        writer = null;
        checkpoint();
        const file = await (await dir.getFileHandle(name)).getFile();
        if (file.size !== received) throw new Error('Video cihaz depolamasına eksik yazıldı. Tekrar dene.');
        blob = file.slice(0, file.size, contentType);
        owners.set(blob, dispose);
        retained = true;
      } else blob = new Blob(chunks, { type: contentType });
      return blob;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (error.name === 'QuotaExceededError') throw storageError();
      if (controller.signal.aborted) throw new Error('Video aktarımı durdu. Bağlantını kontrol edip tekrar dene.');
      throw error;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      if (writer) { try { await writer.abort(); } catch {} }
      if (!retained) await dispose();
    }
  }
  return { download, adopt, release };
}
