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
  fetchImpl = (...args) => globalThis.fetch(...args), makeProxy } = {}) {
  signal?.throwIfAborted();
  const build = makeProxy || (async (source, options) =>
    (await import('./video-proxy.bundle.js')).createAnalysisProxy(source, options));
  onProgress({ phase: 'proxy', loaded: 0, total: 1 });
  const proxy = await build(file, { signal, onProgress: value => onProgress({ phase: 'proxy', ...value }) });
  signal?.throwIfAborted();
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
