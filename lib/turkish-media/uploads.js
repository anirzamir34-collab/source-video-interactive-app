import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_VIDEO_BYTES } from '../../public/media-limits.js';
import { MediaError } from './errors.js';

export const MAX_UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message, status = 400) => new MediaError(code, message, { status });

// Immutable chunk files and atomic metadata publication make acknowledged
// chunks resumable after a restart. Only a completely assembled source is
// exposed to jobs. One process owns this disk store; a job lease protects its
// source from the 24-hour cleanup until all media work has settled.
export function createMediaUploads({ directory, ttlSeconds = 86400, clock = Date.now, fsImpl = fs } = {}) {
  if (!directory) throw new TypeError('An upload directory is required.');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86400) throw new TypeError('Upload TTL must be at most 24 hours.');
  const root = path.resolve(directory);
  const locks = new Map();
  const leases = new Map();
  const location = id => {
    if (!ID.test(String(id))) throw failure('UPLOAD_ID_INVALID', 'Yükleme kimliği geçersiz.');
    return path.join(root, id);
  };
  const keyPath = key => path.join(root, 'keys', `${key}.json`);
  const checkSignal = signal => signal?.throwIfAborted();

  async function locked(key, work) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => gate);
    locks.set(key, chain);
    await previous;
    try { return await work(); }
    finally { release(); if (locks.get(key) === chain) locks.delete(key); }
  }

  async function writeAll(handle, bytes, position = 0) {
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, position + written);
      if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - written) {
        throw failure('CHUNK_SHORT_WRITE', 'Yükleme parçası diske tamamen yazılamadı.', 500);
      }
      written += result.bytesWritten;
    }
  }

  async function atomicJson(filename, value) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fsImpl.open(temporary, 'wx', 0o600);
      await writeAll(handle, Buffer.from(JSON.stringify(value)));
      await handle.sync();
      await handle.close(); handle = null;
      await fsImpl.rename(temporary, filename);
    } finally {
      await handle?.close().catch(() => {});
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function read(id) {
    const directory = location(id);
    try {
      const value = JSON.parse(await fsImpl.readFile(path.join(directory, 'upload.json'), 'utf8'));
      if (value.id !== id || !Number.isSafeInteger(value.totalSize) || value.totalSize <= 0 || value.totalSize > MAX_VIDEO_BYTES ||
          !Number.isSafeInteger(value.chunkSize) || value.chunkSize <= 0 || value.chunkSize > MAX_UPLOAD_CHUNK_BYTES ||
          !value.chunks || typeof value.chunks !== 'object') return null;
      if (value.expiresAt <= clock() && !leases.has(id)) return null;
      for (const [index, entry] of Object.entries(value.chunks)) {
        if (!/^\d+$/.test(index) || Number(index) >= Math.ceil(value.totalSize / value.chunkSize) || !HASH.test(entry.sha256) ||
            entry.size !== Math.min(value.chunkSize, value.totalSize - Number(index) * value.chunkSize)) return null;
      }
      if (value.complete) {
        const source = await fsImpl.stat(path.join(directory, 'source.bin'));
        if (!source.isFile() || source.size !== value.totalSize || !HASH.test(value.sourceHash)) return null;
      } else {
        for (const [index, entry] of Object.entries(value.chunks)) {
          const chunk = await fsImpl.stat(path.join(directory, `chunk-${index}.bin`));
          if (!chunk.isFile() || chunk.size !== entry.size) return null;
        }
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  const touch = value => Object.assign(value, { updatedAt: clock(), expiresAt: clock() + ttlSeconds * 1000 });
  const save = value => atomicJson(path.join(location(value.id), 'upload.json'), value);
  const dto = (value, extra = {}) => {
    const receivedChunks = Object.keys(value.chunks).map(Number).sort((a, b) => a - b);
    let nextChunk = 0;
    while (value.chunks[nextChunk]) nextChunk += 1;
    return { available: true, id: value.id, uploadId: value.id, chunkSize: value.chunkSize,
      totalSize: value.totalSize, receivedSize: Object.values(value.chunks).reduce((sum, chunk) => sum + chunk.size, 0),
      receivedChunks, nextChunk, complete: value.complete === true, ...extra };
  };

  async function start(input = {}) {
    const totalSize = input.totalSize;
    const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_BYTES;
    const fileName = String(input.fileName || input.name || 'source.mp4').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const mimeType = String(input.mimeType || input.mime || 'video/mp4').split(';')[0].trim().toLowerCase();
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_VIDEO_BYTES) {
      throw failure('INVALID_SOURCE_SIZE', 'Kaynak dosya boyutu geçersiz; en fazla 2 GiB yüklenebilir.');
    }
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_UPLOAD_CHUNK_BYTES) {
      throw failure('INVALID_CHUNK_SIZE', 'Yükleme parçası en fazla 10 MiB olabilir.');
    }
    if (!/^(?:video\/(?:mp4|quicktime|webm|x-m4v|ogg|3gpp|3gpp2|x-matroska)|audio\/(?:wav|x-wav|mpeg|mp3|mp4|ogg|webm|flac|x-flac)|application\/octet-stream)$/.test(mimeType)) {
      throw failure('UNSUPPORTED_VIDEO_FORMAT', 'Kaynak medya biçimi desteklenmiyor.', 415);
    }
    const clientKey = input.clientUploadKey;
    if (clientKey !== undefined && (typeof clientKey !== 'string' || !clientKey.trim() || clientKey.length > 512)) {
      throw failure('UPLOAD_KEY_INVALID', 'Cihaz yükleme kimliği geçersiz.');
    }
    const keyHash = clientKey ? digest(clientKey.trim()) : null;
    return locked(keyHash ? `key:${keyHash}` : `new:${randomUUID()}`, async () => {
      await fsImpl.mkdir(path.join(root, 'keys'), { recursive: true });
      if (keyHash) {
        let key;
        try { key = JSON.parse(await fsImpl.readFile(keyPath(keyHash), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (key?.id && ID.test(key.id)) {
          const existing = await locked(`upload:${key.id}`, () => read(key.id));
          if (existing) {
            if (existing.totalSize !== totalSize || existing.mimeType !== mimeType || existing.chunkSize !== chunkSize || existing.fileName !== fileName) {
              throw failure('UPLOAD_KEY_CONFLICT', 'Aynı yükleme kimliği farklı bir kaynak dosyasıyla kullanılamaz.', 409);
            }
            return locked(`upload:${key.id}`, async () => {
              const current = await read(key.id);
              if (!current) throw failure('UPLOAD_SESSION_NOT_FOUND', 'Yükleme oturumu artık kullanılabilir değil.', 404);
              touch(current); await save(current);
              return dto(current, { reused: true });
            });
          }
        }
      }
      const id = randomUUID();
      const value = touch({ version: 1, id, totalSize, chunkSize, fileName, mimeType, clientKeyHash: keyHash,
        chunks: {}, complete: false, createdAt: clock() });
      await fsImpl.mkdir(location(id), { recursive: true });
      try {
        await save(value);
        if (keyHash) await atomicJson(keyPath(keyHash), { id });
        return dto(value, { reused: false });
      } catch (error) {
        await fsImpl.rm(location(id), { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function assemble(value, signal) {
    const directory = location(value.id);
    const temporary = path.join(directory, `.source-${randomUUID()}.tmp`);
    let output;
    try {
      output = await fsImpl.open(temporary, 'wx', 0o600);
      const sourceHash = createHash('sha256');
      let position = 0;
      for (let index = 0; index < Math.ceil(value.totalSize / value.chunkSize); index += 1) {
        checkSignal(signal);
        const chunk = await fsImpl.readFile(path.join(directory, `chunk-${index}.bin`));
        const entry = value.chunks[index];
        if (chunk.length !== entry.size || digest(chunk) !== entry.sha256) throw failure('CHUNK_CHECKSUM_INVALID', 'Yükleme parçasının bütünlüğü doğrulanamadı.', 409);
        await writeAll(output, chunk, position);
        position += chunk.length; sourceHash.update(chunk);
      }
      if (position !== value.totalSize) throw failure('SOURCE_SIZE_MISMATCH', 'Kaynak dosya tamamen yüklenemedi.', 409);
      checkSignal(signal);
      await output.sync(); await output.close(); output = null;
      await fsImpl.rename(temporary, path.join(directory, 'source.bin'));
      value.sourceHash = sourceHash.digest('hex'); value.complete = true;
      await save(touch(value));
      await Promise.all(Object.keys(value.chunks).map(index => fsImpl.rm(path.join(directory, `chunk-${index}.bin`), { force: true }).catch(() => {})));
    } finally {
      await output?.close().catch(() => {});
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function writeChunk(id, index, bytes, { signal } = {}) {
    location(id);
    if (!Number.isSafeInteger(index) || index < 0) throw failure('INVALID_CHUNK_INDEX', 'Yükleme parçası kimliği geçersiz.');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_UPLOAD_CHUNK_BYTES) throw failure('INVALID_CHUNK_BODY', 'Yükleme parçası boş veya çok büyük.');
    return locked(`upload:${id}`, async () => {
      checkSignal(signal);
      const value = await read(id);
      if (!value) throw failure('UPLOAD_SESSION_NOT_FOUND', 'Yükleme oturumu bulunamadı veya süresi doldu.', 404);
      const count = Math.ceil(value.totalSize / value.chunkSize);
      if (index >= count || bytes.length !== Math.min(value.chunkSize, value.totalSize - index * value.chunkSize)) {
        throw failure('INVALID_CHUNK_RANGE', 'Yükleme parçasının uzunluğu kaynak aralığıyla eşleşmiyor.');
      }
      const sha256 = digest(bytes);
      if (value.chunks[index]) {
        if (value.chunks[index].sha256 !== sha256) throw failure('CHUNK_ID_CONFLICT', 'Bu parça kimliği farklı kaynak baytlarıyla tekrar kullanılamaz.', 409);
        if (!value.complete && Object.keys(value.chunks).length === count) await assemble(value, signal);
        else await save(touch(value));
        return dto(value, { duplicate: true });
      }
      const file = path.join(location(id), `chunk-${index}.bin`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      let acknowledged = false;
      try {
        handle = await fsImpl.open(temporary, 'wx', 0o600);
        await writeAll(handle, bytes);
        checkSignal(signal);
        await handle.sync(); await handle.close(); handle = null;
        await fsImpl.rename(temporary, file);
        value.chunks[index] = { size: bytes.length, sha256 };
        await save(touch(value)); acknowledged = true;
        if (Object.keys(value.chunks).length === count) await assemble(value, signal);
        return dto(value, { duplicate: false });
      } finally {
        await handle?.close().catch(() => {});
        await fsImpl.rm(temporary, { force: true }).catch(() => {});
        if (!acknowledged) await fsImpl.rm(file, { force: true }).catch(() => {});
      }
    });
  }

  async function status(id) {
    return locked(`upload:${id}`, async () => {
      const value = await read(id);
      if (!value) return null;
      if (!value.complete && Object.keys(value.chunks).length === Math.ceil(value.totalSize / value.chunkSize)) await assemble(value);
      return dto(value);
    });
  }

  async function source(id) {
    return locked(`upload:${id}`, async () => {
      const value = await read(id);
      if (!value) throw failure('UPLOAD_SESSION_NOT_FOUND', 'Kaynak yükleme bulunamadı veya süresi doldu.', 404);
      if (!value.complete) throw failure('UPLOAD_INCOMPLETE', 'Kaynak video tamamen yüklenmeden işlem başlatılamaz.', 409);
      await save(touch(value));
      return { path: path.join(location(id), 'source.bin'), hash: value.sourceHash };
    });
  }

  async function acquireLeaseByPath(filename) {
    const sourcePath = path.resolve(filename);
    const id = path.basename(path.dirname(sourcePath));
    if (!ID.test(id) || sourcePath !== path.join(location(id), 'source.bin')) throw failure('SOURCE_FILE_INVALID', 'Kaynak dosya bu yükleme deposuna ait değil.');
    return locked(`upload:${id}`, async () => {
      const value = await read(id);
      if (!value?.complete) throw failure('UPLOAD_SESSION_NOT_FOUND', 'Yüklenmiş kaynak video artık kullanılabilir değil.', 404);
      leases.set(id, (leases.get(id) || 0) + 1);
      try { await save(touch(value)); }
      catch (error) { const count = leases.get(id) - 1; if (count) leases.set(id, count); else leases.delete(id); throw error; }
      let released = false;
      return async () => {
        if (released) return; released = true;
        await locked(`upload:${id}`, async () => {
          try { const current = await read(id); if (current) await save(touch(current)); }
          finally { const count = leases.get(id) - 1; if (count > 0) leases.set(id, count); else leases.delete(id); }
        });
      };
    });
  }

  async function removeExpired() {
    const entries = await fsImpl.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const id of entries.filter(name => ID.test(name))) {
      await locked(`upload:${id}`, async () => {
        if (leases.has(id)) return;
        let value;
        try { value = JSON.parse(await fsImpl.readFile(path.join(location(id), 'upload.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (!value || value.expiresAt <= clock()) {
          await fsImpl.rm(location(id), { recursive: true, force: true });
          if (HASH.test(value?.clientKeyHash || '')) {
            const key = await fsImpl.readFile(keyPath(value.clientKeyHash), 'utf8').then(JSON.parse).catch(() => null);
            if (key?.id === id) await fsImpl.rm(keyPath(value.clientKeyHash), { force: true });
          }
        }
      });
    }
  }

  return { start, status, writeChunk, source, acquireLeaseByPath, removeExpired };
}
