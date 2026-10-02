export class MediaError extends Error {
  constructor(code, message, { status = 502, retryable = false, segmentIds = [], cause } = {}) {
    super(message, { cause });
    this.name = 'MediaError';
    Object.assign(this, { code, status, retryable, segmentIds });
  }
}

export function redactMediaSecrets(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:xi-api-key|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

export function publicMediaError(error, secrets = []) {
  return {
    code: String(error?.code || 'MEDIA_JOB_FAILED'),
    message: redactMediaSecrets(error?.message || 'Türkçe medya işlemi tamamlanamadı.', secrets).slice(0, 1500),
    retryable: error?.retryable === true,
    segmentIds: Array.isArray(error?.segmentIds) ? error.segmentIds.map(String) : [],
  };
}
