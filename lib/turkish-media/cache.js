import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 1;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATION_PATTERN = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.artifacts$/;
const STAGING_PATTERN = /^\.([a-f0-9]{64})\.[a-f0-9-]{36}\.(?:json\.)?tmp$/;
const MANIFEST_FIELDS = [
  'version', 'key', 'createdAt', 'expiresAt', 'value',
  'artifactDirectory', 'artifacts', 'integrity',
].sort();

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/** SHA256 over canonical JSON structure and binary bytes in distinct domains. */
export function hashKey(value) {
  const hash = createHash('sha256');
  const ancestors = new Set();
  function token(kind, content = '') {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    hash.update(`${kind}:${bytes.length}:`);
    hash.update(bytes);
  }
  function visit(current, arrayItem = false) {
    const binary = current !== null && typeof current === 'object' ? bytesOf(current) : null;
    if (binary !== null) {
      token('binary', binary);
      return;
    }
    if (current === null) {
      token('null');
      return;
    }
    if (typeof current === 'string') {
      token('string', JSON.stringify(current));
      return;
    }
    if (typeof current === 'boolean') {
      token('boolean', current ? 'true' : 'false');
      return;
    }
    if (typeof current === 'number') {
      token('number', Number.isFinite(current) ? JSON.stringify(current) : 'null');
      return;
    }
    if (typeof current === 'bigint') throw new TypeError('BigInt is not JSON serializable.');
    if (typeof current !== 'object') {
      if (arrayItem) token('null');
      else throw new TypeError('Value is not JSON serializable.');
      return;
    }
    if (ancestors.has(current)) throw new TypeError('Cannot hash circular data.');
    ancestors.add(current);
    try {
      if (typeof current.toJSON === 'function') {
        const replacement = current.toJSON();
        if (replacement !== current) {
          visit(replacement, arrayItem);
          return;
        }
      }
      if (Array.isArray(current)) {
        token('array-start', String(current.length));
        for (let i = 0; i < current.length; i += 1) visit(current[i], true);
        token('array-end');
        return;
      }
      const keys = Object.keys(current).filter(key => (
        current[key] !== undefined
        && typeof current[key] !== 'function'
        && typeof current[key] !== 'symbol'
      )).sort();
      token('object-start', String(keys.length));
      for (const key of keys) {
        token('property', JSON.stringify(key));
        visit(current[key]);
      }
      token('object-end');
    } finally {
      ancestors.delete(current);
    }
  }
  visit(value);
  return hash.digest('hex');
}

function checkKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TypeError('Cache key must be a lowercase SHA256 hex digest.');
  }
  return key;
}

function checkArtifactName(name) {
  if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) {
    throw new TypeError('Artifact name must be a safe filename without path components.');
  }
  return name;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readRegularFile(filename, expectedSize) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (expectedSize !== undefined && stat.size !== expectedSize)) {
      throw new Error('Cache file metadata does not match.');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function digestFile(filename, expectedSize) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (expectedSize !== undefined && stat.size !== expectedSize)) {
      throw new Error('Cache file metadata does not match.');
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== stat.size) throw new Error('Cache file changed while reading.');
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function manifestBody(manifest) {
  return {
    version: manifest.version,
    key: manifest.key,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    value: manifest.value,
    artifactDirectory: manifest.artifactDirectory,
    artifacts: manifest.artifacts,
  };
}

/**
 * Atomic disk cache for JSON values and optional binary artifacts.
 *
 * put(key, value, { artifacts: { 'audio.wav': Buffer | { path: filename } } })
 * publishes one manifest
 * only after its complete artifact generation is on disk. get returns the JSON
 * value unchanged; getArtifact returns bytes, and getArtifactPath returns a
 * validated path. Hold acquireLease(key) until a path consumer finishes reading.
 * Leases protect eviction, never make an expired entry a cache hit.
 */
export function createMediaCache({ directory, ttlSeconds = 86400, clock = Date.now } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('A cache directory is required.');
  }
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds < 0
    || !Number.isFinite(ttlSeconds * 1000)) {
    throw new TypeError('ttlSeconds must be a finite nonnegative number.');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  const root = path.resolve(directory);
  const leases = new Map();
  const flights = new Map();
  const mutations = new Map();
  const verifiedFiles = new Map();
  const verificationFlights = new Map();

  async function validateArtifactFile(filename, metadata) {
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(metadata.size)) return false;
      const mark = `${fingerprint(before)}:${metadata.sha256}`;
      if (verifiedFiles.get(filename) === mark) return true;
      const flightKey = `${filename}:${mark}`;
      let pending = verificationFlights.get(flightKey);
      if (!pending) {
        pending = (async () => {
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
          return size === metadata.size && hash.digest('hex') === metadata.sha256;
        })();
        verificationFlights.set(flightKey, pending);
      }
      let valid;
      try { valid = await pending; }
      finally { if (verificationFlights.get(flightKey) === pending) verificationFlights.delete(flightKey); }
      if (!valid || fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) return false;
      verifiedFiles.delete(filename); verifiedFiles.set(filename, mark);
      if (verifiedFiles.size > 512) verifiedFiles.delete(verifiedFiles.keys().next().value);
      return true;
    } finally { await handle.close(); }
  }

  function now() {
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('clock must return a finite millisecond timestamp.');
    }
    return value;
  }

  function acquireLease(key) {
    checkKey(key);
    leases.set(key, (leases.get(key) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = leases.get(key) - 1;
      if (count > 0) leases.set(key, count);
      else leases.delete(key);
    };
  }

  function mutate(key, work) {
    const preceding = mutations.get(key) || Promise.resolve();
    const pending = preceding.catch(() => {}).then(work);
    mutations.set(key, pending);
    const clear = () => {
      if (mutations.get(key) === pending) mutations.delete(key);
    };
    pending.then(clear, clear);
    return pending;
  }

  function generationPath(key, generation) {
    if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)
      || !generation.startsWith(`${key}.`)) {
      throw new Error('Invalid cache artifact directory.');
    }
    return path.join(root, generation);
  }

  async function readManifest(key) {
    let manifest;
    try {
      const bytes = await readRegularFile(path.join(root, `${key}.json`));
      manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object'
        || Object.keys(manifest).sort().join(',') !== MANIFEST_FIELDS.join(',')
        || manifest.version !== CACHE_VERSION || manifest.key !== key
        || !Number.isFinite(manifest.createdAt) || !Number.isFinite(manifest.expiresAt)
        || manifest.expiresAt < manifest.createdAt
        || !manifest.artifacts || Array.isArray(manifest.artifacts)
        || typeof manifest.artifacts !== 'object'
        || manifest.integrity !== hashKey(manifestBody(manifest))) {
        return null;
      }
      const names = Object.keys(manifest.artifacts);
      if ((names.length === 0 && manifest.artifactDirectory !== null)
        || (names.length > 0 && manifest.artifactDirectory === null)) return null;
      if (names.length > 0) generationPath(key, manifest.artifactDirectory);
      for (const name of names) {
        checkArtifactName(name);
        const artifact = manifest.artifacts[name];
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
          || Object.keys(artifact).sort().join(',') !== 'sha256,size'
          || !Number.isSafeInteger(artifact.size) || artifact.size < 0
          || typeof artifact.sha256 !== 'string' || !KEY_PATTERN.test(artifact.sha256)) {
          return null;
        }
      }
      return manifest;
    } catch {
      return null;
    }
  }

  async function readEntry(key, requestedBytes) {
    const timestamp = now();
    const manifest = await readManifest(key);
    if (!manifest || timestamp >= manifest.expiresAt) return null;
    const artifacts = new Map();
    try {
      if (manifest.artifactDirectory !== null) {
        const artifactRoot = generationPath(key, manifest.artifactDirectory);
        const handle = await open(artifactRoot,
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_DIRECTORY || 0));
        try {
          if (!(await handle.stat()).isDirectory()) return null;
        } finally {
          await handle.close();
        }
        for (const [name, metadata] of Object.entries(manifest.artifacts)) {
          const filename = path.join(artifactRoot, name);
          if (name === requestedBytes) {
            const bytes = await readRegularFile(filename, metadata.size);
            if (bytes.length !== metadata.size || digest(bytes) !== metadata.sha256) return null;
            artifacts.set(name, { bytes, filename });
          } else {
            // JSON/path hits validate large audio with bounded streaming memory.
            if (!await validateArtifactFile(filename, metadata)) return null;
            artifacts.set(name, { filename });
          }
        }
      }
      // A slow disk read must not deliver an entry that expired during validation.
      if (now() >= manifest.expiresAt) return null;
      return { manifest, artifacts };
    } catch {
      return null;
    }
  }

  async function get(key) {
    checkKey(key);
    const release = acquireLease(key);
    try {
      return (await readEntry(key))?.manifest.value ?? null;
    } finally {
      release();
    }
  }

  async function getArtifact(key, name) {
    checkKey(key);
    checkArtifactName(name);
    const release = acquireLease(key);
    try {
      return (await readEntry(key, name))?.artifacts.get(name)?.bytes ?? null;
    } finally {
      release();
    }
  }

  async function getArtifactPath(key, name) {
    checkKey(key);
    checkArtifactName(name);
    const release = acquireLease(key);
    try {
      return (await readEntry(key))?.artifacts.get(name)?.filename ?? null;
    } finally {
      release();
    }
  }

  function put(key, value, { artifacts = {} } = {}) {
    checkKey(key);
    if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
      return Promise.reject(new TypeError('artifacts must be a filename-to-bytes object.'));
    }
    let storedValue;
    const preparedArtifacts = [];
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError('Cache value must be JSON serializable.');
      storedValue = JSON.parse(serialized);
      for (const [name, valueBytes] of Object.entries(artifacts)) {
        checkArtifactName(name);
        const bytes = bytesOf(valueBytes);
        if (bytes !== null) {
          // Copy before queueing, so callers cannot mutate a pending publication.
          preparedArtifacts.push({ name, bytes: Buffer.from(bytes) });
        } else if (valueBytes && typeof valueBytes === 'object'
          && typeof valueBytes.path === 'string' && valueBytes.path.length > 0
          && !valueBytes.path.includes('\0')
          && Object.keys(valueBytes).length === 1) {
          preparedArtifacts.push({ name, sourcePath: path.resolve(valueBytes.path) });
        } else {
          throw new TypeError('Artifact data must be binary bytes or { path: filename }.');
        }
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const release = acquireLease(key);
    const pending = mutate(key, async () => {
      const nonce = randomUUID();
      const generation = preparedArtifacts.length > 0 ? `${key}.${nonce}.artifacts` : null;
      const stagingDirectory = path.join(root, `.${key}.${nonce}.tmp`);
      const manifestTemporary = path.join(root, `.${key}.${nonce}.json.tmp`);
      const artifactMetadata = Object.create(null);
      let published = false;
      try {
        await mkdir(root, { recursive: true });
        if (generation !== null) {
          await mkdir(stagingDirectory);
          for (const { name, bytes, sourcePath } of preparedArtifacts) {
            const filename = path.join(stagingDirectory, name);
            if (sourcePath !== undefined) {
              await copyFile(sourcePath, filename, constants.COPYFILE_EXCL);
            }
            const handle = await open(filename,
              sourcePath === undefined ? 'wx' : constants.O_RDWR | (constants.O_NOFOLLOW || 0),
              0o600);
            try {
              if (sourcePath === undefined) await handle.writeFile(bytes);
              else await handle.chmod(0o600);
              await handle.sync();
            } finally {
              await handle.close();
            }
            artifactMetadata[name] = sourcePath === undefined
              ? { size: bytes.length, sha256: digest(bytes) }
              : await digestFile(filename);
          }
          await rename(stagingDirectory, generationPath(key, generation));
        }
        const createdAt = now();
        const expiresAt = createdAt + ttlSeconds * 1000;
        if (!Number.isFinite(expiresAt)) throw new TypeError('Cache expiry exceeds timestamp range.');
        const body = {
          version: CACHE_VERSION, key, createdAt, expiresAt, value: storedValue,
          artifactDirectory: generation, artifacts: artifactMetadata,
        };
        const manifest = { ...body, integrity: hashKey(body) };
        const handle = await open(manifestTemporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(manifest));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(manifestTemporary, path.join(root, `${key}.json`));
        published = true;
        return storedValue;
      } finally {
        await rm(manifestTemporary, { force: true }).catch(() => {});
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
        if (!published && generation !== null) {
          await rm(generationPath(key, generation), { recursive: true, force: true }).catch(() => {});
        }
      }
    });
    pending.then(release, release);
    return pending;
  }

  async function removeExpired() {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if ((!entry.isFile() && !entry.isSymbolicLink())
        || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const key = entry.name.slice(0, -5);
      await mutate(key, async () => {
        if (leases.has(key)) return;
        const manifest = await readManifest(key);
        if (manifest && now() < manifest.expiresAt) {
          // Replacing a value can leave an old generation until all path/read
          // leases finish. The current generation always remains untouched.
          for (const candidate of entries) {
            if (GENERATION_PATTERN.test(candidate.name)
              && candidate.name.startsWith(`${key}.`)
              && candidate.name !== manifest.artifactDirectory) {
              await rm(generationPath(key, candidate.name), { recursive: true, force: true });
            }
          }
          return;
        }
        try {
          await unlink(path.join(root, entry.name));
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        removed += 1;
        // Match directories against the key; never trust paths from a corrupt JSON.
        for (const candidate of entries) {
          if (GENERATION_PATTERN.test(candidate.name) && candidate.name.startsWith(`${key}.`)) {
            await rm(generationPath(key, candidate.name), { recursive: true, force: true });
          }
        }
      });
    }
    // An interrupted publication may leave a staging file or a complete
    // generation with no manifest. Neither can be a hit, and active writes have
    // already acquired their key lease before creating them.
    for (const entry of entries) {
      const staging = STAGING_PATTERN.exec(entry.name);
      const generation = GENERATION_PATTERN.test(entry.name);
      if (!staging && !generation) continue;
      const key = staging ? staging[1] : entry.name.slice(0, 64);
      await mutate(key, async () => {
        if (leases.has(key)) return;
        if (generation) {
          const manifest = await readManifest(key);
          if (manifest?.artifactDirectory === entry.name) return;
        }
        await rm(path.join(root, entry.name), { recursive: true, force: true });
      });
    }
    return removed;
  }

  // This function deliberately is not async: simultaneous callers receive the
  // exact same native Promise, including when work throws synchronously.
  function singleFlight(key, work) {
    checkKey(key);
    if (typeof work !== 'function') throw new TypeError('work must be a function.');
    if (flights.has(key)) return flights.get(key);
    const release = acquireLease(key);
    const pending = Promise.resolve().then(work);
    flights.set(key, pending);
    const settle = () => {
      if (flights.get(key) === pending) flights.delete(key);
      release();
    };
    pending.then(settle, settle);
    return pending;
  }

  return {
    hashKey, get, put, removeExpired, singleFlight, acquireLease,
    getArtifact, getArtifactPath, directory: root,
  };
}
