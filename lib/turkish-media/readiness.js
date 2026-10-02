import { execFile } from 'node:child_process';

// Best-effort startup diagnostics only. This does not call a provider or prove
// model access; callers decide how to publish the report without blocking app
// startup. Never include environment values, binary paths or process output.
export async function runtimeReady({ config, env = process.env, ffmpegPath, ffprobePath,
  execFileImpl = execFile, timeoutMs = 5000, signal } = {}) {
  const present = value => typeof value === 'string' && Boolean(value.trim());
  const checks = {
    appPasswordConfigured: present(env?.APP_PASSWORD),
    elevenLabsConfigured: present(config?.elevenLabs?.apiKey ?? env?.ELEVENLABS_API_KEY),
    geminiConfigured: present(config?.translation?.apiKey ?? env?.GEMINI_API_KEY),
    qualityOnly: (config?.qualityMode ?? env?.DUB_QUALITY_MODE ?? 'quality') === 'quality',
    ffmpegExecutable: false,
    ffprobeExecutable: false,
  };
  const errors = [];
  const warnings = [];
  const missing = [
    ['appPasswordConfigured', 'APP_PASSWORD_NOT_CONFIGURED', 'APP_PASSWORD is not configured.'],
    ['qualityOnly', 'QUALITY_MODE_UNAVAILABLE', 'Only quality mode is available.'],
  ];
  for (const [check, code, message] of missing) if (!checks[check]) errors.push({ check, code, message });
  for (const [check, code, message] of [
    ['elevenLabsConfigured', 'ELEVENLABS_NOT_CONFIGURED', 'Backend ElevenLabs key is not configured; browser keys are supported.'],
    ['geminiConfigured', 'GEMINI_NOT_CONFIGURED', 'Backend Gemini key is not configured; browser keys are supported.'],
  ]) if (!checks[check]) warnings.push({ check, code, message });
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : 5000;
  async function probe(binary, check, name) {
    if (!present(binary)) return { check, code: 'MEDIA_BINARY_NOT_CONFIGURED', message: `${name} is not configured.` };
    if (signal?.aborted) return { check, code: 'MEDIA_CHECK_CANCELLED', message: `${name} check was cancelled.` };
    try {
      const output = await new Promise((resolve, reject) => {
        execFileImpl(binary, ['-version'], { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
          encoding: 'utf8', windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      if (!new RegExp(`^${name} version\\s`, 'im').test(String(output))) {
        return { check, code: 'MEDIA_BINARY_INVALID_RESPONSE', message: `${name} did not return its version.` };
      }
      checks[check] = true;
      return null;
    } catch (error) {
      const code = signal?.aborted || error?.code === 'ABORT_ERR' ? 'MEDIA_CHECK_CANCELLED'
        : error?.killed === true || error?.code === 'ETIMEDOUT' ? 'MEDIA_CHECK_TIMEOUT'
          : ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? `MEDIA_BINARY_${error.code}` : 'MEDIA_BINARY_EXECUTION_FAILED';
      return { check, code, message: `${name} could not be executed successfully.` };
    }
  }
  const failures = await Promise.all([probe(ffmpegPath, 'ffmpegExecutable', 'ffmpeg'), probe(ffprobePath, 'ffprobeExecutable', 'ffprobe')]);
  errors.push(...failures.filter(Boolean));
  return {
    ready: ['appPasswordConfigured', 'qualityOnly', 'ffmpegExecutable', 'ffprobeExecutable'].every(check => checks[check]),
    checkedAt: new Date().toISOString(), checks, errors, warnings,
    serverMediaConfigured: checks.elevenLabsConfigured && checks.geminiConfigured,
    browserKeysSupported: { gemini: true, elevenLabs: true },
  };
}
