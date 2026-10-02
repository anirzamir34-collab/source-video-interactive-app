import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMediaRequest } from './http.js';
import { createElevenLabsProvider } from './elevenlabs.js';
import { createTranslationProvider } from './translation.js';
import { createTurkishMediaPipeline } from './pipeline.js';
import { MediaError, publicMediaError, redactMediaSecrets } from './errors.js';
import { publicMediaConfig } from './config.js';
import { createLimiter } from './limiter.js';

const terminal = new Set(['READY', 'FAILED', 'CANCELLED']);
const uuid = /^[a-f0-9-]{36}$/i;

// Browser credentials belong to request/worker memory, never the persisted
// source input. An invalid supplied key must not silently bill the server key.
export function validateMediaCredentials(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MediaError('MEDIA_CREDENTIAL_INVALID', 'Sağlayıcı anahtarı geçersiz.', { status: 400 });
  }
  const limits = { elevenLabsApiKey: 1024, geminiApiKey: 512 };
  const labels = { elevenLabsApiKey: 'ElevenLabs', geminiApiKey: 'Gemini' };
  const result = {};
  for (const name of Object.keys(limits)) {
    const raw = value[name];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string') {
      throw new MediaError('MEDIA_CREDENTIAL_INVALID', `${labels[name]} API anahtarı metin olmalı.`, { status: 400 });
    }
    const key = raw.trim();
    // Provider API keys are opaque credentials. Do not assume a provider's
    // current alphabet; only enforce HTTP-header-safe printable ASCII, no
    // whitespace/control characters, and a bounded length.
    if (key.length < 20 || key.length > limits[name] || !/^[\x21-\x7E]+$/.test(key)) {
      throw new MediaError('MEDIA_CREDENTIAL_INVALID',
        `${labels[name]} API anahtarı geçersiz biçimde veya uzunlukta. Anahtarı doğrudan sağlayıcı panelinden kopyala.`,
        { status: 400 });
    }
    result[name] = key;
  }
  return result;
}

export function createMediaJobs({ config, cache, limiter, audio, fetchImpl = globalThis.fetch, leaseSource = () => () => {}, onFailure = () => {} }) {
  const directory = path.join(config.directory, 'jobs');
  const running = new Map();
  const persisted = new Map();
  // One video owns the pipeline at a time; scene/turn work inside it is bounded
  // by the configured shared limiter. A cancelled owner cannot abort a second
  // job's single-flight provider request.
  const jobQueue = createLimiter(1);
  function effectiveConfig(credentials) {
    const selected = validateMediaCredentials(credentials);
    const elevenLabs = { ...config.elevenLabs, apiKey: selected.elevenLabsApiKey || config.elevenLabs.apiKey };
    const translation = { ...config.translation, apiKey: selected.geminiApiKey || config.translation.apiKey };
    // Only this domain-separated fingerprint is written to disk. It partitions
    // billed provider stages without retaining recoverable credential values.
    const credentialScope = crypto.createHash('sha256').update(JSON.stringify([
      'videoquest-media-credentials-v1', elevenLabs.apiKey || '', translation.apiKey || '',
    ])).digest('hex');
    return { ...config, elevenLabs, translation, credentialScope };
  }
  function requireProviders(effective, input) {
    if (!effective.elevenLabs.apiKey) throw new MediaError('ELEVENLABS_NOT_CONFIGURED', 'ElevenLabs anahtarı tarayıcıdan gönderilmeli veya sunucuda tanımlanmalı.', { status: 503 });
    if (!input.outputs?.transcriptOnly && !effective.translation.apiKey) throw new MediaError('GEMINI_NOT_CONFIGURED', 'Gemini anahtarı tarayıcıdan gönderilmeli veya sunucuda tanımlanmalı.', { status: 503 });
  }
  const jobPath = id => {
    if (!uuid.test(id)) throw new MediaError('JOB_ID_INVALID', 'İşlem kimliği geçersiz.', { status: 400 });
    return path.join(directory, id);
  };
  async function save(job) {
    await fs.mkdir(jobPath(job.id), { recursive: true });
    const target = path.join(jobPath(job.id), 'job.json');
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
    await fs.rename(temp, target);
    persisted.set(job.id, job);
  }
  async function read(id) {
    if (persisted.has(id)) return persisted.get(id);
    try {
      const value = JSON.parse(await fs.readFile(path.join(jobPath(id), 'job.json'), 'utf8'));
      if (value.id !== id) return null;
      if (!terminal.has(value.state) && !running.has(id)) {
        value.state = 'FAILED';
        value.error = { code: 'JOB_INTERRUPTED', message: 'Sunucu yeniden başlatıldı. Tamamlanan aşamalar cache’den kullanılarak devam edilebilir.', retryable: true };
        await save(value);
      }
      persisted.set(id, value);
      return value;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  function publicResult(job) {
    if (!job.result) return undefined;
    const result = structuredClone(job.result);
    const prefix = `/api/turkish-media/jobs/${job.id}/artifacts/`;
    result.assets = job.input.outputs?.transcriptOnly ? {} : {
      sourceSrt: { url: `${prefix}source_tr.srt` }, sourceVtt: { url: `${prefix}source_tr.vtt` },
      dubSrt: { url: `${prefix}dub_tr.srt` }, dubVtt: { url: `${prefix}dub_tr.vtt` },
      ...(job.input.outputs?.dub && !job.input.outputs?.transcriptOnly ? {
        mix: { url: `${prefix}mix.wav`, mimeType: 'audio/wav', duration: result.qualityReport.sourceDuration },
      } : {}),
    };
    delete result.artifactKey;
    return result;
  }
  function publicJob(job) {
    return { id: job.id, state: job.state, progress: job.progress, message: job.message,
      error: job.error || null, sourceTranscript: job.sourceTranscript || null,
      ...(job.qualityReport ? { qualityReport: job.qualityReport } : {}),
      ...(job.state === 'READY' ? { result: publicResult(job) } : {}),
      statusUrl: `/api/turkish-media/jobs/${job.id}`,
    };
  }
  function launch(job, effective) {
    if (running.has(job.id)) return;
    const controller = new AbortController();
    const owner = { controller, done: null };
    running.set(job.id, owner);
    owner.done = (async () => {
      let releaseSource;
      const secrets = [config.elevenLabs.apiKey, config.translation.apiKey, effective.elevenLabs.apiKey, effective.translation.apiKey];
      const stats = { cacheHits: 0, elevenLabsRequestCount: 0, retryCount: 0 };
      try {
        releaseSource = await leaseSource(job.input.source.path);
        const request = createMediaRequest({ fetchImpl, timeoutMs: effective.requestTimeoutMs, maxRetries: effective.maxRetries, secrets,
          onRequest: ({ url }) => { if (url.startsWith(effective.elevenLabs.baseUrl)) stats.elevenLabsRequestCount += 1; },
          onRetry: () => { stats.retryCount += 1; } });
        const pipeline = createTurkishMediaPipeline({ config: effective, cache, limiter, audio,
          elevenLabs: createElevenLabsProvider({ config: effective, request }),
          translationProvider: createTranslationProvider({ config: effective, request }),
        });
        const result = await jobQueue.run(() => pipeline({ ...job.input, directory: jobPath(job.id) }, {
          signal: controller.signal, stats, jobId: job.id,
          onStage: async update => {
            controller.signal.throwIfAborted();
            Object.assign(job, update, { updatedAt: Date.now(), error: null });
            await save(job);
          },
        }), { signal: controller.signal });
        controller.signal.throwIfAborted();
        Object.assign(job, { state: 'READY', progress: 100, message: 'Türkçe medya hazır.', result,
          qualityReport: result.qualityReport, updatedAt: Date.now() });
      } catch (error) {
        job.state = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
        job.message = job.state === 'CANCELLED' ? 'İşlem iptal edildi.' : 'Türkçe medya işlemi tamamlanamadı.';
        job.error = publicMediaError(error, secrets);
        job.error.code = redactMediaSecrets(job.error.code, secrets);
        job.error.segmentIds = job.error.segmentIds.map(value => redactMediaSecrets(value, secrets));
        job.qualityReport = { ...job.qualityReport, ...error.qualityReport,
          sourceDuration: job.sourceTranscript?.source?.duration ?? error.qualityReport?.sourceDuration ?? null,
          detectedLanguage: job.sourceTranscript?.language ?? null,
          speakerCount: job.sourceTranscript?.speakers?.length ?? 0,
          sourceUtteranceCount: job.sourceTranscript?.utterances?.length ?? 0,
          failedSegments: job.error.segmentIds || [], ...stats };
        job.updatedAt = Date.now();
        if (job.state === 'FAILED') { try { onFailure({ jobId: job.id, ...job.error }); } catch {} }
      } finally {
        await Promise.resolve().then(() => releaseSource?.()).catch(() => {});
        await save(job).catch(() => {});
        running.delete(job.id);
      }
    })();
  }
  async function create(input, credentials) {
    const effective = effectiveConfig(credentials);
    requireProviders(effective, input);
    if (input.outputs?.dub && (input.qualityMode || config.qualityMode) === 'fast') {
      throw new MediaError('FAST_MODEL_PROTOCOL_UNVERIFIED', 'Eleven v4 Turbo WebSocket protokolü resmi olarak doğrulanmadan hızlı mod açılamaz; kalite modu kullanılabilir.', { status: 422 });
    }
    const stat = await fs.stat(input.source.path);
    if (!stat.isFile() || !stat.size) throw new MediaError('SOURCE_FILE_INVALID', 'Kaynak video dosyası geçersiz.', { status: 400 });
    // Allowlist the pipeline input so credentials in a body/extra field cannot
    // accidentally be serialized by a caller bypassing the HTTP routes.
    const safeInput = { source: { path: input.source.path,
      ...(input.source.hash ? { hash: input.source.hash } : {}),
      ...(Number.isFinite(input.source.duration) ? { duration: input.source.duration } : {}) },
      outputs: { dub: input.outputs?.dub === true, subtitles: input.outputs?.subtitles !== false, transcriptOnly: input.outputs?.transcriptOnly === true },
      qualityMode: input.qualityMode, voiceMapping: input.voiceMapping || {},
      previousVoiceMapping: input.previousVoiceMapping || {}, sceneContext: input.sceneContext || [] };
    const job = { id: crypto.randomUUID(), input: safeInput, credentialScope: effective.credentialScope, state: 'PREPARING_AUDIO', progress: 0,
      message: 'Türkçe medya işlemi sıraya alındı.', createdAt: Date.now(), updatedAt: Date.now(), error: null };
    await save(job);
    launch(job, effective);
    return publicJob(job);
  }
  async function get(id) {
    const job = await read(id);
    if (!job || job.updatedAt + config.cacheTtlSeconds * 1000 < Date.now()) return null;
    return publicJob(job);
  }
  async function cancel(id) {
    const job = await read(id);
    if (!job) return null;
    running.get(id)?.controller.abort(new DOMException('İşlem iptal edildi.', 'AbortError'));
    return publicJob(job);
  }
  async function retry(id, credentials) {
    const job = await read(id);
    if (!job) return null;
    const effective = effectiveConfig(credentials);
    requireProviders(effective, job.input);
    if (job.credentialScope !== effective.credentialScope) throw new MediaError('MEDIA_CREDENTIAL_SCOPE_MISMATCH', 'Bu işlemi sürdürmek için aynı sağlayıcı anahtarlarını yeniden gönder. Farklı anahtarlarla yeni işlem başlatılmalı.', { status: 403 });
    if (running.has(id)) {
      if (!terminal.has(job.state)) return publicJob(job);
      await running.get(id).done;
    }
    if (job.state === 'READY') return publicJob(job);
    job.error = null; job.state = 'PREPARING_AUDIO'; job.progress = 0; job.updatedAt = Date.now();
    delete job.qualityReport;
    await save(job); launch(job, effective); return publicJob(job);
  }
  async function artifact(id, name) {
    const job = await read(id);
    if (!job || job.state !== 'READY' || !job.result?.artifactKey) return null;
    if (!['mix.wav', 'source_tr.srt', 'source_tr.vtt', 'dub_tr.srt', 'dub_tr.vtt'].includes(name)) return null;
    const release = cache.acquireLease(job.result.artifactKey);
    try {
      const filePath = await cache.getArtifactPath(job.result.artifactKey, name);
      if (filePath) return { path: filePath, release };
      release();
      return null;
    } catch (error) { release(); throw error; }
  }
  async function removeExpired() {
    const cutoff = Date.now() - config.cacheTtlSeconds * 1000;
    const entries = await fs.readdir(directory).catch(() => []);
    for (const id of entries.filter(name => uuid.test(name))) {
      if (running.has(id)) continue;
      const job = await read(id);
      if (job && job.updatedAt < cutoff) { await fs.rm(jobPath(id), { recursive: true, force: true }); persisted.delete(id); }
    }
    await cache.removeExpired();
  }
  async function voices(credentials) {
    const effective = effectiveConfig(credentials);
    requireProviders(effective, { outputs: { transcriptOnly: true } });
    const secrets = [config.elevenLabs.apiKey, config.translation.apiKey, effective.elevenLabs.apiKey, effective.translation.apiKey];
    const request = createMediaRequest({ fetchImpl, timeoutMs: effective.requestTimeoutMs,
      maxRetries: effective.maxRetries, secrets });
    const catalog = await createElevenLabsProvider({ config: effective, request }).listVoices();
    return catalog.map(voice => ({ voiceId: redactMediaSecrets(String(voice.voice_id), secrets), name: redactMediaSecrets(String(voice.name || voice.voice_id), secrets),
      gender: ['male', 'female'].includes(voice.labels?.gender) ? voice.labels.gender : null,
      language: redactMediaSecrets(String(voice.labels?.language || ''), secrets) }));
  }
  return { create, get, cancel, retry, artifact, removeExpired, voices,
    capabilities: credentials => ({ ...publicMediaConfig(effectiveConfig(credentials)),
      serverMediaConfigured: Boolean(config.elevenLabs.apiKey && config.translation.apiKey) }) };
}
