// Experimental "Video ile analiz": small analysis copy on the phone, resumable
// upload to our server, then the server hands it to the Gemini Files API.
const API = '/api/turkish-media';
const CHUNK = 8 * 1024 * 1024;

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `İstek başarısız (${response.status}).`),
    { status: response.status, code: body.reason || body.code });
  return body;
}

export async function prepareGeminiVideo(file, { signal, headers = {}, onProgress = () => {},
  fetchImpl = (...args) => globalThis.fetch(...args), makeProxy, directUpload } = {}) {
  signal?.throwIfAborted();
  const build = makeProxy || (async (source, options) =>
    (await import('./video-proxy.bundle.js')).createAnalysisProxy(source, options));
  onProgress({ phase: 'proxy', loaded: 0, total: 1 });
  const proxy = await build(file, { signal, onProgress: value => onProgress({ phase: 'proxy', ...value }) });
  signal?.throwIfAborted();
  // First choice: the copy goes from the phone straight to Google, so it does
  // not use the server's bandwidth. Any failure falls back to the server path.
  if (!makeProxy || directUpload) {
    try {
      const direct = await uploadDirect(proxy, { signal, headers, onProgress, fetchImpl, upload: directUpload });
      if (direct) return direct;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const started = await json(await fetchImpl(`${API}/uploads/start`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: proxy.name || 'analysis-proxy.mp4', mimeType: proxy.type || 'video/mp4', totalSize: proxy.size, chunkSize: CHUNK }) }));
  const uploadId = started.uploadId || started.id;
  const size = Number(started.chunkSize) || CHUNK;
  const total = Math.ceil(proxy.size / size);
  for (let index = 0; index < total; index++) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await json(await fetchImpl(`${API}/uploads/${encodeURIComponent(uploadId)}/chunk/${index}`, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/octet-stream' },
          body: proxy.slice(index * size, Math.min(proxy.size, (index + 1) * size)) }));
        break;
      } catch (error) {
        if (signal?.aborted || attempt >= 2 || (error.status && error.status < 500 && ![408, 429].includes(error.status))) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
    onProgress({ phase: 'upload', loaded: Math.min(proxy.size, (index + 1) * size), total: proxy.size });
  }
  onProgress({ phase: 'google', loaded: 0, total: 1 });
  const prepared = await json(await fetchImpl('/api/gemini-video/prepare', { method: 'POST', signal,
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId, mimeType: proxy.type || 'video/mp4' }) }));
  if (!prepared.fileUri) throw new Error('Google video kimliği alınamadı.');
  return { fileUri: prepared.fileUri, mimeType: prepared.mimeType || proxy.type || 'video/mp4', proxyBytes: proxy.size };
}

// Sends the bytes to Google's resumable upload URL with upload progress.
function putWithProgress(url, blob, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const XHR = globalThis.XMLHttpRequest;
    if (typeof XHR !== 'function') { reject(new Error('XHR_UNAVAILABLE')); return; }
    const xhr = new XHR();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.upload.onprogress = event => onProgress({ phase: 'upload', loaded: event.loaded, total: blob.size });
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(Object.assign(new Error(`Google yükleme hatası (${xhr.status}).`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new TypeError('Google yükleme bağlantısı kurulamadı.'));
    xhr.ontimeout = () => reject(new Error('Google yükleme zaman aşımı.'));
    const abort = () => { xhr.abort(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}

async function uploadDirect(proxy, { signal, headers, onProgress, fetchImpl, upload = putWithProgress }) {
  const type = proxy.type || 'video/mp4';
  const session = await json(await fetchImpl('/api/gemini-video/direct-start', { method: 'POST', signal,
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ size: proxy.size, mimeType: type }) }));
  if (!session.uploadUrl) return null;
  onProgress({ phase: 'upload', loaded: 0, total: proxy.size, direct: true });
  const uploaded = await upload(session.uploadUrl, proxy, { signal, onProgress });
  const name = uploaded?.file?.name;
  if (!name) return null;
  onProgress({ phase: 'google', loaded: 0, total: 1 });
  const ready = await json(await fetchImpl('/api/gemini-video/direct-finish', { method: 'POST', signal,
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: type }) }));
  if (!ready.fileUri) return null;
  return { fileUri: ready.fileUri, mimeType: ready.mimeType || type, proxyBytes: proxy.size, direct: true };
}
