// Fetch has no upload progress events. XHR reports actual network bytes for
// audio chunks and multipart storyboard requests, then a separate wait for ACK.
export function requestWithUploadProgress(url, { method = 'POST', headers = {}, body, signal,
  timeoutMs = 120000, onProgress = () => {}, XMLHttpRequestClass = globalThis.XMLHttpRequest } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequestClass();
    let settled = false, loaded = 0, total = Number(body?.size) || 0;
    const finish = (handler, value) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', abort);
      handler(value);
    };
    const abort = () => {
      finish(reject, signal?.reason || new DOMException('İşlem iptal edildi.', 'AbortError'));
      xhr.abort();
    };
    const report = phase => onProgress({ loaded, total, phase });
    xhr.open(method, url, true); xhr.timeout = timeoutMs;
    new Headers(headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = event => {
      if (settled || signal?.aborted) return;
      loaded = event.loaded; if (event.lengthComputable) total = event.total;
      report('sending');
    };
    xhr.upload.onload = () => {
      if (settled || signal?.aborted) return;
      if (total) loaded = total;
      report('waiting');
    };
    xhr.onload = () => {
      const text = xhr.responseText, status = xhr.status;
      finish(resolve, { ok: status >= 200 && status < 300, status,
        json: async () => JSON.parse(text) });
    };
    xhr.onerror = () => finish(reject, Object.assign(new Error('Aktarım bağlantısı kesildi.'), { code: 'NETWORK_ERROR' }));
    xhr.ontimeout = () => finish(reject, Object.assign(new Error('Aktarım isteği zaman aşımına uğradı.'), { code: 'REQUEST_TIMEOUT' }));
    xhr.onabort = () => finish(reject, signal?.reason || new DOMException('İşlem iptal edildi.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { report('sending'); xhr.send(body); }
    catch (error) { finish(reject, error); }
  });
}
