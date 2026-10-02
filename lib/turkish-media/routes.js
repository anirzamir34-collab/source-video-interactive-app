import path from 'node:path';
import { MediaError, publicMediaError } from './errors.js';

function voiceMapping(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length > 64) {
    throw new MediaError('VOICE_MAPPING_INVALID', 'Ses eşlemesi en fazla 64 konuşmacı kimliğinden oluşmalı.', { status: 400 });
  }
  const result = {};
  for (const [speakerId, voiceId] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(speakerId) || /^(?:__proto__|constructor|prototype)$/i.test(speakerId) ||
        typeof voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) {
      throw new MediaError('VOICE_MAPPING_INVALID', 'Konuşmacı ve ses kimlikleri geçerli, sınırlı uzunlukta metinler olmalı.', { status: 400 });
    }
    result[speakerId] = voiceId;
  }
  return result;
}

function sceneContext(value) {
  if (value === undefined) return [];
  const invalid = () => new MediaError('SCENE_CONTEXT_INVALID', 'Sahne bağlamı geçerli kaynak aralıkları ve sınırlı uzunlukta metinler içermeli.', { status: 400 });
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const textFields = ['id', 'sceneId', 'label', 'title', 'sceneTitle', 'sceneGoal', 'description', 'summary', 'storySummary', 'location', 'evidence'];
  let textLength = 0;
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid();
    const startTime = row.startTime ?? row.start;
    const endTime = row.endTime ?? row.end;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) throw invalid();
    const context = { startTime, endTime };
    for (const field of textFields) {
      if (row[field] === undefined) continue;
      if (typeof row[field] !== 'string' || row[field].length > 2000) throw invalid();
      textLength += row[field].length;
      if (textLength > 32768) throw invalid();
      context[field] = row[field];
    }
    // Browser scene descriptions are hints. Browser-supplied verification,
    // confidence and arbitrary metadata can never certify source-video facts.
    return context;
  });
}

// Install after the application's owner authentication middleware. Upload
// transport and artifact serving are independent of the paid providers.
export function installTurkishMediaRoutes(app, { uploads, jobs, rawParser, secrets = [] } = {}) {
  if (!uploads || !jobs || typeof rawParser !== 'function') throw new TypeError('Media uploads, jobs and rawParser are required.');
  const prefix = '/api/turkish-media';
  const notFound = () => new MediaError('MEDIA_NOT_FOUND', 'Medya işlemi veya dosyası bulunamadı.', { status: 404 });
  const wrapper = work => async (req, res, next) => {
    try { await work(req, res); }
    catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return next(error);
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const publicError = error instanceof MediaError ? publicMediaError(error, secrets) : {
        code: 'MEDIA_REQUEST_FAILED', message: 'Medya isteği tamamlanamadı.', retryable: false, segmentIds: [],
      };
      res.status(status).json({ available: false, reason: publicError.code, error: publicError, message: publicError.message });
    }
  };
  const requireJob = async id => {
    const value = await jobs.get(id);
    if (!value) throw notFound();
    return value;
  };

  app.get(`${prefix}/capabilities`, wrapper(async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(jobs.capabilities());
  }));
  app.get(`${prefix}/voices`, wrapper(async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ voices: await jobs.voices() });
  }));
  app.post(`${prefix}/uploads/start`, wrapper(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await uploads.start(req.body));
  }));
  app.get(`${prefix}/uploads/:id/status`, wrapper(async (req, res) => {
    const value = await uploads.status(req.params.id);
    if (!value) throw notFound();
    res.setHeader('Cache-Control', 'no-store'); res.json(value);
  }));
  app.post(`${prefix}/uploads/:id/chunk/:index`, rawParser, wrapper(async (req, res) => {
    if (!/^\d+$/.test(req.params.index)) throw new MediaError('INVALID_CHUNK_INDEX', 'Yükleme parçası kimliği geçersiz.', { status: 400 });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new DOMException('Yükleme bağlantısı kapandı.', 'AbortError')); };
    req.once('aborted', abort); res.once('close', abort);
    if (req.aborted || res.destroyed) abort();
    try {
      const value = await uploads.writeChunk(req.params.id, Number(req.params.index), req.body, { signal: controller.signal });
      if (!res.destroyed) res.json(value);
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  }));

  app.post(`${prefix}/jobs`, wrapper(async (req, res) => {
    const body = req.body || {};
    const outputs = { dub: body.outputs?.dub === true, subtitles: body.outputs?.subtitles !== false, transcriptOnly: body.outputs?.transcriptOnly === true };
    if (outputs.transcriptOnly) { outputs.dub = false; outputs.subtitles = false; }
    if (!outputs.dub && !outputs.subtitles && !outputs.transcriptOnly) {
      throw new MediaError('OUTPUTS_REQUIRED', 'En az bir medya çıktısı seçilmeli.', { status: 400 });
    }
    if (body.qualityMode !== undefined && !['quality', 'fast'].includes(body.qualityMode)) {
      throw new MediaError('QUALITY_MODE_INVALID', 'Dublaj kalite modu geçersiz.', { status: 400 });
    }
    const selectedVoices = voiceMapping(body.voiceMapping);
    const previousVoices = voiceMapping(body.previousVoiceMapping);
    const context = sceneContext(body.sceneContext);
    const source = await uploads.source(body.uploadId);
    // A browser duration is never trusted as the source-video duration. The
    // central audio service probes the original container on the server.
    const input = { source, outputs, qualityMode: body.qualityMode,
      voiceMapping: selectedVoices, previousVoiceMapping: previousVoices, sceneContext: context };
    const value = await jobs.create(input);
    res.status(202).json({ ...value, jobId: value.id });
  }));
  app.get(`${prefix}/jobs/:id`, wrapper(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.json(await requireJob(req.params.id));
  }));
  app.post(`${prefix}/jobs/:id/retry`, wrapper(async (req, res) => {
    const value = await jobs.retry(req.params.id);
    if (!value) throw notFound();
    res.status(202).json({ ...value, jobId: value.id });
  }));
  app.post(`${prefix}/jobs/:id/cancel`, wrapper(async (req, res) => {
    const value = await jobs.cancel(req.params.id);
    if (!value) throw notFound();
    res.json(value);
  }));
  app.get(`${prefix}/jobs/:id/result`, wrapper(async (req, res) => {
    const value = await requireJob(req.params.id);
    if (value.state !== 'READY' || !value.result) throw new MediaError('MEDIA_NOT_READY', 'Medya işlemi henüz hazır değil.', { status: 409 });
    res.setHeader('Cache-Control', 'no-store'); res.json(value.result);
  }));
  app.get(`${prefix}/jobs/:id/artifacts/:name`, wrapper(async (req, res) => {
    const name = req.params.name;
    if (!['mix.wav', 'source_tr.srt', 'source_tr.vtt', 'dub_tr.srt', 'dub_tr.vtt'].includes(name)) throw notFound();
    const value = await jobs.artifact(req.params.id, name);
    if (!value) throw notFound();
    let released = false;
    const release = () => {
      if (released) return; released = true;
      res.removeListener('finish', release); res.removeListener('close', release);
      value.release();
    };
    res.once('finish', release); res.once('close', release);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.vtt') ? 'text/vtt' : 'application/x-subrip');
    // Express sends actual bytes and handles Range/If-Range, HEAD and 416.
    try {
      res.sendFile(path.resolve(value.path), { acceptRanges: true, cacheControl: false }, error => {
        if (!error) return;
        release();
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) return res.destroy(error);
        const status = error.statusCode === 416 ? 416 : error.statusCode === 404 ? 404 : 500;
        res.status(status).json({ available: false, reason: status === 416 ? 'MEDIA_RANGE_INVALID' : 'MEDIA_ARTIFACT_UNAVAILABLE',
          message: 'İstenen medya dosyası aralığı gönderilemedi.' });
      });
    } catch (error) { release(); throw error; }
  }));
}
