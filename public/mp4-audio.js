import { MAX_AUDIO_BYTES } from './media-limits.js';

// Remux a regular MP4's first AAC track using Blob slices. Only its index is
// read into JS memory; video payload is neither decoded nor copied/uploaded.
// Preserve timing/edit lists, including AAC priming and delayed audio starts.
// Fragmented, encrypted and unsupported containers use the existing fallback.
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const PACK_BYTES = 1024 * 1024;
const MAX_PACK_SLICES = 2048;
const PREPARATION_TIMEOUT_MS = 120000;
const invalid = () => { throw new Error('MP4_AUDIO_UNSUPPORTED'); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tag = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

function readBlob(blob, signal) {
  signal?.throwIfAborted();
  if (!signal) return blob.arrayBuffer();
  // Blob.arrayBuffer has no abort argument. Release the caller even if Android
  // never settles a read, and ignore its eventual result after cancellation.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      handler(value);
    };
    const aborted = () => finish(reject, signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return blob.arrayBuffer(); })
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function header(bytes, at, end) {
  if (at + 8 > bytes.length) invalid();
  const data = view(bytes);
  let size = data.getUint32(at);
  let head = 8;
  if (size === 1) {
    if (at + 16 > bytes.length) invalid();
    size = Number(data.getBigUint64(at + 8));
    head = 16;
  } else if (size === 0) size = end - at;
  if (!Number.isSafeInteger(size) || size < head || at + size > end) invalid();
  return { type: tag(bytes, at + 4), start: at, data: at + head, end: at + size, size };
}

function children(bytes, box) {
  const result = [];
  for (let at = box.data; at < box.end;) {
    const child = header(bytes, at, box.end);
    result.push(child);
    at = child.end;
  }
  return result;
}

function required(rows, type) {
  const matches = rows.filter(row => row.type === type);
  if (matches.length !== 1) invalid();
  return matches[0];
}

function atom(type, parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  view(bytes).setUint32(0, size);
  bytes.set([...type].map(char => char.charCodeAt(0)), 4);
  let at = 8;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return bytes;
}

function table(bytes, box, width, prefix = 8) {
  if (box.data + prefix > box.end) invalid();
  const count = view(bytes).getUint32(box.data + prefix - 4);
  if (!count || box.data + prefix + count * width !== box.end) invalid();
  return count;
}

// A File made from thousands of tiny slices is cheap on desktop but Android
// can stall while XHR walks that fragmented Blob. Copy only the compact audio
// payload into bounded MiB blocks so upload reads remain sequential and fast.
export async function packAudioChunks(file, chunks, audioBytes, packBytes = PACK_BYTES,
  { signal, onProgress = () => {} } = {}) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(audioBytes) || audioBytes <= 0 ||
      !Number.isSafeInteger(packBytes) || packBytes <= 0) invalid();
  const parts = [];
  let copied = 0;
  let slices = [];
  let queued = 0;
  const flush = async () => {
    // One bounded read per batch, rather than thousands of serialized reads
    // of tiny samples. Only audio slices enter this Blob; video stays on disk.
    const bytes = new Uint8Array(await readBlob(new Blob(slices), signal));
    signal?.throwIfAborted();
    if (bytes.byteLength !== queued) invalid();
    parts.push(bytes);
    copied += queued;
    slices = [];
    queued = 0;
    onProgress({ phase: 'packing', loaded: copied, total: audioBytes });
    // Yield once per completed batch so the phone can paint real progress.
    await new Promise(resolve => setTimeout(resolve, 0));
    signal?.throwIfAborted();
  };
  for (const chunk of chunks) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(chunk.start) || chunk.start < 0 ||
        !Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.start + chunk.size > file.size) invalid();
    let source = chunk.start;
    let remaining = chunk.size;
    while (remaining > 0) {
      const count = Math.min(remaining, packBytes - queued);
      if (copied + queued + count > audioBytes) invalid();
      slices.push(file.slice(source, source + count));
      queued += count;
      source += count;
      remaining -= count;
      if (queued === packBytes || slices.length === MAX_PACK_SLICES) await flush();
    }
  }
  if (queued) await flush();
  if (copied !== audioBytes) invalid();
  return parts;
}

async function remux(file, { signal, onProgress }) {
  signal.throwIfAborted();
  if (!(file instanceof Blob) || file.size < 16) return null;
  onProgress({ phase: 'index', loaded: 0, total: 0 });
  let index;
  let fileType;
  const media = [];
  for (let at = 0, count = 0; at < file.size; count++) {
    if (count >= 10000) invalid();
    const bytes = new Uint8Array(await readBlob(file.slice(at, at + 16), signal));
    const box = header(bytes, 0, file.size - at);
    if (box.type === 'moof') return null;
    if (box.type === 'moov') {
      if (index || box.size > MAX_INDEX_BYTES) invalid();
      index = new Uint8Array(await readBlob(file.slice(at, at + box.size), signal));
    } else if (box.type === 'ftyp') {
      if (fileType || box.size > 65536) invalid();
      fileType = new Uint8Array(await readBlob(file.slice(at, at + box.size), signal));
    } else if (box.type === 'mdat') media.push({ start: at + box.data, end: at + box.end });
    at += box.size;
  }
  if (!index || !fileType || !media.length) return null;
  const data = view(index);
  const movie = children(index, header(index, 0, index.length));
  if (movie.some(box => box.type === 'mvex')) return null;
  const mvhd = required(movie, 'mvhd');
  let track, trackRows, mdia, mdiaRows;
  for (const candidate of movie.filter(box => box.type === 'trak')) {
    const rows = children(index, candidate);
    const candidateMdia = required(rows, 'mdia');
    const candidateRows = children(index, candidateMdia);
    const handler = required(candidateRows, 'hdlr');
    if (handler.data + 12 > handler.end) invalid();
    if (tag(index, handler.data + 8) !== 'soun') continue;
    track = candidate; trackRows = rows; mdia = candidateMdia; mdiaRows = candidateRows;
    break;
  }
  if (!track) return null;
  const minf = required(mdiaRows, 'minf');
  const minfRows = children(index, minf);
  const stbl = required(minfRows, 'stbl');
  const rows = children(index, stbl);
  // Do not preserve offset-bearing encryption/reference structures blindly.
  const supported = new Set(['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'sdtp', 'sgpd', 'sbgp']);
  if (rows.some(box => !supported.has(box.type))) return null;
  const stsd = required(rows, 'stsd');
  if (stsd.data + 8 > stsd.end || data.getUint32(stsd.data + 4) !== 1) return null;
  const entry = header(index, stsd.data + 8, stsd.end);
  if (entry.type !== 'mp4a' || entry.end !== stsd.end || entry.data + 28 > entry.end) return null;
  if (data.getUint16(entry.data + 6) !== 1 || data.getUint16(entry.data + 8) !== 0) return null;
  const codecBoxes = children(index, { data: entry.data + 28, end: entry.end });
  if (!codecBoxes.some(box => box.type === 'esds') || codecBoxes.some(box => box.type === 'sinf')) return null;
  const dinf = required(minfRows, 'dinf');
  const dref = required(children(index, dinf), 'dref');
  if (dref.data + 8 > dref.end || data.getUint32(dref.data + 4) !== 1) return null;
  const reference = header(index, dref.data + 8, dref.end);
  if (reference.type !== 'url ' || reference.data + 4 !== reference.end ||
      reference.end !== dref.end || data.getUint32(reference.data) !== 1) return null;

  const stsc = required(rows, 'stsc');
  const stsz = required(rows, 'stsz');
  const offsetBoxes = rows.filter(box => ['stco', 'co64'].includes(box.type));
  if (offsetBoxes.length !== 1) invalid();
  const offsets = offsetBoxes[0];
  const width = offsets.type === 'co64' ? 8 : 4;
  const chunkCount = table(index, offsets, width);
  const mappingCount = table(index, stsc, 12);
  if (stsz.data + 12 > stsz.end) invalid();
  const sampleSize = data.getUint32(stsz.data + 4);
  const sampleCount = data.getUint32(stsz.data + 8);
  if (!sampleCount || sampleCount > 10000000 || chunkCount > 1000000 ||
      stsz.data + 12 + (sampleSize ? 0 : sampleCount * 4) !== stsz.end) invalid();
  const mappings = [];
  for (let i = 0; i < mappingCount; i++) {
    const at = stsc.data + 8 + i * 12;
    const first = data.getUint32(at), samples = data.getUint32(at + 4);
    if (!samples || first < 1 || first > chunkCount || data.getUint32(at + 8) !== 1 ||
        (i === 0 ? first !== 1 : first <= mappings.at(-1).first)) invalid();
    mappings.push({ first, samples });
  }
  const chunks = [];
  let sample = 0, mapping = 0, audioBytes = 0;
  for (let i = 0; i < chunkCount; i++) {
    signal.throwIfAborted();
    if (mapping + 1 < mappings.length && mappings[mapping + 1].first === i + 1) mapping++;
    const count = mappings[mapping].samples;
    if (sample + count > sampleCount) invalid();
    let size = sampleSize * count;
    if (!sampleSize) for (let j = 0; j < count; j++) size += data.getUint32(stsz.data + 12 + (sample + j) * 4);
    sample += count;
    const at = offsets.data + 8 + i * width;
    const start = width === 8 ? Number(data.getBigUint64(at)) : data.getUint32(at);
    if (!Number.isSafeInteger(start) || !size || !media.some(box => start >= box.start && start + size <= box.end)) invalid();
    audioBytes += size;
    if (audioBytes + index.length + fileType.length + 8 > MAX_AUDIO_BYTES) return null;
    chunks.push({ start, size });
    if (i && i % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (sample !== sampleCount) invalid();

  const raw = box => index.subarray(box.start, box.end);
  const stco = new Uint8Array(8 + chunkCount * 4);
  view(stco).setUint32(4, chunkCount);
  const rebuild = () => {
    const newTable = atom('stbl', rows.map(box => box === offsets ? atom('stco', [stco]) : raw(box)));
    const newMinf = atom('minf', minfRows.map(box => box === stbl ? newTable : raw(box)));
    const newMdia = atom('mdia', mdiaRows.map(box => box === minf ? newMinf : raw(box)));
    const newTrack = atom('trak', trackRows.filter(box => ['tkhd', 'edts', 'mdia'].includes(box.type))
      .map(box => box === mdia ? newMdia : raw(box)));
    return atom('moov', [raw(mvhd), newTrack]);
  };
  let movieBytes = rebuild();
  let position = fileType.length + movieBytes.length + 8;
  for (let i = 0; i < chunks.length; i++) {
    view(stco).setUint32(8 + i * 4, position);
    position += chunks[i].size;
  }
  movieBytes = rebuild();
  const mdat = atom('mdat', []);
  view(mdat).setUint32(0, audioBytes + 8);
  const packedAudio = await packAudioChunks(file, chunks, audioBytes, PACK_BYTES, { signal, onProgress });
  signal.throwIfAborted();
  return new File([fileType, movieBytes, mdat, ...packedAudio],
    'dialogue.m4a', { type: 'audio/mp4' });
}

export async function extractMp4Audio(file, { signal, onProgress = () => {}, timeoutMs = PREPARATION_TIMEOUT_MS } = {}) {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(Object.assign(new Error('Cihazda ses hazırlama zaman aşımına uğradı.'),
    { code: 'LOCAL_AUDIO_PREPARATION_TIMEOUT' })), Math.max(1, Number(timeoutMs) || PREPARATION_TIMEOUT_MS));
  try { return await remux(file, { signal: combined, onProgress }); }
  catch (error) {
    if (combined.aborted) throw combined.reason;
    if (error.message === 'MP4_AUDIO_UNSUPPORTED' || error instanceof RangeError) return null;
    throw error;
  } finally { clearTimeout(timer); }
}
