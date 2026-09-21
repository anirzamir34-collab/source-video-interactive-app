const PART_BYTES = 2 * 1024 * 1024;
const MIN_BYTES = 8 * 1024 * 1024;
const CONNECTIONS = 4;

function rangeOf(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end
    ? { start, end, total } : null;
}

function validatorOf(response) {
  const etag = response.headers.get('etag') || '';
  if (/^"[^\r\n]*"$/.test(etag)) return { name: 'etag', value: etag };
  const modified = response.headers.get('last-modified') || '';
  const date = Date.parse(response.headers.get('date') || '');
  // A date validator must be old enough to avoid merging two writes in the
  // same second. Without usable identity metadata use the ordinary stream.
  if (Number.isFinite(Date.parse(modified)) && date - Date.parse(modified) >= 60000) {
    return { name: 'last-modified', value: modified };
  }
  return null;
}

const retrySerial = (message = 'Parçalı aktarım desteklenmedi; normal aktarım deneniyor.') =>
  Object.assign(new Error(message), { code: 'VIDEO_RANGE_RETRY', retrySerial: true });

// Return an ordinary Response either way. Consumers keep their existing disk
// writer, size limits and cleanup. At most one 8 MiB batch is held in memory.
export async function openVideoDownload(url, {
  fetchVideo, signal, requestOptions = {}, parallel = false, maxBytes = Infinity, onNetwork
}) {
  if (!parallel) return fetchVideo(url, { ...requestOptions, signal });
  const group = new AbortController();
  const combined = signal ? AbortSignal.any([signal, group.signal]) : group.signal;
  const first = await fetchVideo(url, { ...requestOptions, signal: combined, headers: { Range: 'bytes=0-0' } });
  if (first.status !== 206) {
    // A server may ignore Range and send the whole file. Reuse that response.
    if (![400, 416].includes(first.status)) return first;
    await first.body?.cancel();
    group.abort();
    return fetchVideo(url, { ...requestOptions, signal });
  }
  const initial = rangeOf(first);
  const validator = validatorOf(first);
  if (!initial || initial.start !== 0 || initial.end !== 0 || initial.total < MIN_BYTES ||
      initial.total > maxBytes || !validator || !first.body ||
      !['', 'identity'].includes(first.headers.get('content-encoding') || '')) {
    await first.body?.cancel();
    group.abort();
    return fetchVideo(url, { ...requestOptions, signal });
  }
  const total = initial.total;
  let loaded = 0;
  let offset = 1;
  let prefix = first;
  let ready = [];
  let inflight = [];
  const readers = new Set();
  let cancelled = false;
  const readPart = async (response, start, end) => {
    let reader;
    try {
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry || '') - Date.now()) / 1000;
        throw Object.assign(retrySerial('Kaynak geçici hız sınırı uyguladı. Normal aktarım kısa süre sonra denenebilir.'), {
          retryAfterMs: Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 2000)
        });
      }
      const part = rangeOf(response);
      const expected = end - start + 1;
      const length = response.headers.get('content-length');
      if (response.status !== 206 || !part || part.start !== start || part.end !== end || part.total !== total ||
          response.headers.get(validator.name) !== validator.value || (length && Number(length) !== expected) ||
          !['', 'identity'].includes(response.headers.get('content-encoding') || '') || !response.body) throw retrySerial();
      reader = response.body.getReader();
      readers.add(reader);
      const bytes = new Uint8Array(expected);
      let count = 0;
      while (true) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        if (count + value.byteLength > expected) throw retrySerial();
        bytes.set(value, count);
        count += value.byteLength;
        loaded += value.byteLength;
        onNetwork?.({ loaded, total, connections: CONNECTIONS });
      }
      if (count !== expected) throw retrySerial();
      return bytes;
    } finally {
      try { if (reader) await reader.cancel(); else await response.body?.cancel(); } catch {}
      if (reader) { readers.delete(reader); reader.releaseLock(); }
    }
  };
  const stop = async reason => {
    cancelled = true;
    group.abort(reason);
    ready = [];
    await Promise.allSettled([...readers].map(reader => reader.cancel()));
    if (prefix) { try { await prefix.body?.cancel(); } catch {} prefix = null; }
    await Promise.allSettled(inflight);
    inflight = [];
  };
  const body = new ReadableStream({
    async pull(stream) {
      try {
        combined.throwIfAborted();
        if (prefix) {
          const response = prefix;
          prefix = null;
          const bytes = await readPart(response, 0, 0);
          if (!cancelled) stream.enqueue(bytes);
          return;
        }
        if (!ready.length && offset < total) {
          inflight = [];
          for (let i = 0; i < CONNECTIONS && offset < total; i++) {
            const start = offset;
            const end = Math.min(total - 1, start + PART_BYTES - 1);
            offset = end + 1;
            inflight.push((async () => {
              const response = await fetchVideo(url, { ...requestOptions,
                signal: AbortSignal.any([combined, AbortSignal.timeout(45000)]),
                headers: { Range: `bytes=${start}-${end}`, 'If-Range': validator.value } });
              return readPart(response, start, end);
            })());
          }
          ready = await Promise.all(inflight);
          inflight = [];
        }
        if (cancelled) return;
        if (ready.length) stream.enqueue(ready.shift());
        else { stream.close(); group.abort(); }
      } catch (error) {
        const parentAborted = signal?.aborted;
        await stop(error);
        stream.error(parentAborted ? signal.reason : error.retrySerial ? error : retrySerial());
      }
    },
    cancel: stop
  }, { highWaterMark: 0 });
  return new Response(body, { headers: {
    'content-type': first.headers.get('content-type') || 'video/mp4',
    'content-length': String(total)
  } });
}
