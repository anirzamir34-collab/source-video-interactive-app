import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redactMediaSecrets } from './errors.js';

const OUTCOMES = new Set(['completed', 'cache_hit', 'shared_result', 'skipped']);
const STRING_METADATA = ['segmentId', 'cacheScope', 'reason', 'model', 'purpose'];
const NUMBER_METADATA = ['actualDuration', 'fittedDuration', 'targetDuration', 'requiredTempo', 'maxTempo',
  'outputSamples', 'targetSamples', 'wordIndex', 'wordStart', 'wordEnd', 'dubStart', 'dubEnd'];
const SECRET_ENV_NAMES = new Set(['APP_PASSWORD', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
const SECRET_ENV_SUFFIX = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|PRIVATE_KEY|SIGNING_KEY)$/;

// Credential values stay inside the logger; neither environment names nor a
// configuration object become log metadata.
export function configuredLogSecrets(config = {}, env = process.env) {
  const values = [config.elevenLabs?.apiKey, config.translation?.apiKey];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAMES.has(name) || SECRET_ENV_SUFFIX.test(name)) values.push(value);
  }
  return [...new Set(values.filter(value => typeof value === 'string' && value.length))];
}

function property(value, name) {
  try { return value?.[name]; } catch { return undefined; }
}

function textValues(values) {
  return Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length) : [];
}

export function createStageLogger({ jobId, write = entry => console.info(JSON.stringify(entry)),
  secrets = [], privateValues = () => [], now = Date.now, monotonic = () => performance.now() } = {}) {
  function sanitizer() {
    let privateTexts;
    try { privateTexts = textValues(privateValues()); } catch { privateTexts = []; }
    const hidden = [...textValues(secrets), ...privateTexts];
    // Escaped source text can occur inside a provider JSON error or its stack.
    const variants = [...new Set(hidden.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
      .sort((left, right) => right.length - left.length);
    return value => {
      let text = String(value ?? '');
      for (const hiddenValue of variants) text = text.split(hiddenValue).join('[REDACTED]');
      // Redact complete unquoted auth values before a generic header matcher
      // could consume only the scheme and leave its credential behind.
      text = text.replace(/(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;"']+/gi, '$1[REDACTED]');
      text = redactMediaSecrets(text, variants);
      // The common redactor covers bare headers/Bearer tokens. Also cover quoted
      // JSON keys and quoted values, including credentials that contain spaces.
      text = text.replace(/(["']?(?:xi[-_]?api[-_]?key|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/gi,
        '$1[REDACTED]');
      return text;
    };
  }

  function metadataFields(metadata, sanitize) {
    const fields = {};
    for (const key of STRING_METADATA) {
      const value = property(metadata, key);
      if (typeof value === 'string') fields[key] = sanitize(value);
    }
    for (const key of NUMBER_METADATA) {
      const value = property(metadata, key);
      if (Number.isFinite(value) && value >= 0) fields[key] = value;
    }
    const count = property(metadata, 'count');
    if (Number.isFinite(count) && count >= 0) fields.count = count;
    const segmentIds = property(metadata, 'segmentIds');
    if (Array.isArray(segmentIds)) fields.segmentIds = segmentIds
      .filter(value => typeof value === 'string').map(sanitize);
    return fields;
  }

  function errorFields(error, sanitize, depth = 0, seen = new Set()) {
    if (seen.has(error)) return { name: 'Error', message: '[Circular cause]' };
    if (error && typeof error === 'object') seen.add(error);
    const name = property(error, 'name');
    const message = property(error, 'message');
    const fields = {
      name: sanitize(typeof name === 'string' ? name : 'Error'),
      message: sanitize(typeof message === 'string' ? message :
        typeof error === 'string' ? error : 'Media stage failed.'),
    };
    for (const key of ['stack', 'code']) {
      const value = property(error, key);
      if (typeof value === 'string' || (key === 'code' && Number.isFinite(value))) fields[key] = sanitize(value);
    }
    const reason = property(error, 'reason');
    if (typeof reason === 'string') fields.reason = sanitize(reason);
    const segmentIds = property(error, 'segmentIds');
    if (Array.isArray(segmentIds)) fields.segmentIds = segmentIds.filter(value => typeof value === 'string').map(sanitize);
    const status = property(error, 'status');
    for (const key of NUMBER_METADATA) {
      const value = property(error, key);
      if (Number.isFinite(value) && value >= 0) fields[key] = value;
    }
    if (Number.isFinite(status)) fields.status = status;
    const retryable = property(error, 'retryable');
    if (typeof retryable === 'boolean') fields.retryable = retryable;
    const cause = property(error, 'cause');
    if (cause != null && depth < 3) fields.cause = errorFields(cause, sanitize, depth + 1, seen);
    return fields;
  }

  function emit(entry) {
    try {
      const result = write(entry);
      // Async sinks are optional and never block or reject media work.
      if (result != null) Promise.resolve(result).catch(() => {});
    } catch { /* A logging sink cannot change a media result. */ }
  }

  function begin(stage, metadata) {
    const startedAt = new Date(now()).toISOString();
    const startTick = monotonic();
    const operationId = randomUUID();
    const sanitize = sanitizer();
    emit({ ...metadataFields(metadata, sanitize), event: 'media_stage_start',
      jobId: sanitize(jobId), stage: sanitize(stage), operationId, timestamp: startedAt, startedAt });
    return { startedAt, startTick, operationId };
  }

  function end(stage, metadata, operation, outcome, error) {
    const endedAt = new Date(now()).toISOString();
    const durationMs = Math.max(0, monotonic() - operation.startTick);
    const sanitize = sanitizer();
    const entry = { ...metadataFields(metadata, sanitize), event: 'media_stage_end', jobId: sanitize(jobId),
      stage: sanitize(stage), operationId: operation.operationId, timestamp: endedAt,
      startedAt: operation.startedAt, endedAt, durationMs, outcome };
    if (error !== undefined) entry.error = errorFields(error, sanitize);
    emit(entry);
  }

  function failedOutcome(error) {
    return property(error, 'name') === 'AbortError' || property(error, 'code') === 'ABORT_ERR' ? 'cancelled' : 'failed';
  }

  async function run(stage, metadata, work) {
    const operation = begin(stage, metadata);
    let outcome = 'completed';
    try {
      const result = await work({ setOutcome: value => { if (OUTCOMES.has(value)) outcome = value; } });
      end(stage, metadata, operation, outcome);
      return result;
    } catch (error) {
      end(stage, metadata, operation, failedOutcome(error), error);
      throw error;
    }
  }

  function instant(stage, metadata, { outcome, reason } = {}) {
    if (!['cache_hit', 'skipped'].includes(outcome)) throw new TypeError('Instant stage outcome must be cache_hit or skipped.');
    const fields = { ...metadata, ...(typeof reason === 'string' ? { reason } : {}) };
    end(stage, fields, begin(stage, fields), outcome);
  }

  function error(stage, failure, metadata = {}) {
    const endedAt = new Date(now()).toISOString();
    const sanitize = sanitizer();
    emit({ ...metadataFields(metadata, sanitize), event: 'media_stage_end', jobId: sanitize(jobId), stage: sanitize(stage),
      operationId: randomUUID(), timestamp: endedAt, startedAt: endedAt, endedAt, durationMs: 0,
      outcome: failedOutcome(failure), error: errorFields(failure, sanitize) });
  }

  return { run, instant, error };
}
