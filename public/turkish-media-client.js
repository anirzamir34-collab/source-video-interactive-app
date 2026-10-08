import { createSourceAudioPreparer } from './source-audio.js';
import { MAX_AUDIO_BYTES } from './media-limits.js';
import { requestWithUploadProgress } from './progress-request.js';
import { conversationEnd } from './conversation-timing.js';

// The server produces one finished soundtrack. The source video owns every
// playback boundary; this client only follows its clock and renders captions.
const API = '/api/turkish-media';
const MAX_CHUNK = 10 * 1024 * 1024;
const LEGACY_AUDIO_UPLOAD_CHUNK_BYTES = 128 * 1024;
export const AUDIO_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const secretKey = /^(?:.*api[_-]?key|xi-api-key|x-elevenlabs-key|authorization|password|access[_-]?token|refresh[_-]?token|__proto__|constructor|prototype)$/i;

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => secretKey.test(key) ? undefined : item));
}

function abortError(message = 'Türkçe medya işlemi iptal edildi.') {
  return new DOMException(message, 'AbortError');
}

function internalUrl(value, base = globalThis.location?.href || 'http://localhost/') {
  const url = new URL(String(value || ''), base);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(`${API}/`) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Türkçe medya dosyasının adresi geçersiz.');
  }
  return url.pathname;
}

function errorMessage(error, fallback) {
  return typeof error === 'string' ? error : String(error?.message || fallback);
}

function cueRows(track) {
  const rows = Array.isArray(track) ? track : track?.cues || [];
  return rows.map(cue => ({ ...cue,
    start: Number(cue.start ?? cue.startTime), end: Number(cue.end ?? cue.endTime),
    text: String(cue.text ?? cue.turkishText ?? cue.translatedText ?? '')
  })).filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
    cue.start >= 0 && cue.end > cue.start && cue.text.trim())
    .sort((a, b) => a.start - b.start);
}

export function createTurkishMediaClient({ video, captionElements = {}, onStatus = () => {},
  fetchImpl = globalThis.fetch, AudioClass = globalThis.Audio, clock = {},
  getElevenLabsApiKey = () => '', getGeminiApiKey = () => '',
  pollIntervalMs = 1200, requestTimeoutMs = 30000, uploadRequestTimeoutMs = 120000, assetTimeoutMs = 5 * 60 * 1000,
  chunkSize = AUDIO_UPLOAD_CHUNK_BYTES, uploadIdleTimeoutMs = 30000, uploadAckTimeoutMs = 90000,
  prepareSourceAudio = createSourceAudioPreparer(),
  XMLHttpRequestClass = globalThis.XMLHttpRequest,
  retryDelayMs = 1000, maxJobWaitMs = 6 * 60 * 60 * 1000,
  urlImpl = globalThis.URL, baseUrl = globalThis.location?.href || 'http://localhost/'
} = {}) {
  if (!video || typeof fetchImpl !== 'function') throw new Error('Video oynatıcısı hazır değil.');
  // Native Window methods reject the timers object as their receiver on some
  // mobile browsers. Injected clocks and custom transports keep their contract.
  const requestFetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  const timers = {
    set: clock.setTimeout?.bind(clock) || globalThis.setTimeout.bind(globalThis),
    clear: clock.clearTimeout?.bind(clock) || globalThis.clearTimeout.bind(globalThis),
    now: clock.now?.bind(clock) || Date.now,
    frame: clock.requestAnimationFrame?.bind(clock) || globalThis.requestAnimationFrame?.bind(globalThis),
    cancelFrame: clock.cancelAnimationFrame?.bind(clock) || globalThis.cancelAnimationFrame?.bind(globalThis)
  };
  let generation = 0, controller = new AbortController(), destroyed = false;
  let jobId = null, jobState = null, lastStart = null;
  let manifest = null, audio = null, audioBlob = null, audioBlobRequest = null, objectUrl = null;
  let dubEnabled = false, subtitleTrack = 'off', syncOffset = 0;
  let originalMuted = null, waiting = false, sourceEmptied = false, playbackFailed = false, playAttempt = null, playVersion = 0, needsSeek = true;
  let legacySourceVolume = null, legacyAppliedVolume = null, audioOwnsPlayback = false;
  let frame = null;
  const sourceUploadKeys = new WeakMap();
  const tracks = { source_tr: [], dub_tr: [] };
  const { overlay, speaker, text } = captionElements;
  const notify = status => { try { onStatus(jsonCopy(status)); } catch { /* UI callbacks do not own the job. */ } };
  const scope = () => ({ generation, signal: controller.signal });
  const current = owner => !destroyed && owner.generation === generation && !owner.signal.aborted;
  const assertCurrent = owner => { if (!current(owner)) throw abortError(); };

  function requestHeaders(path, options) {
    const headers = new Headers(options.headers);
    const usesProviders = (options.method === 'POST' &&
      (path === `${API}/jobs` || /^\/api\/turkish-media\/jobs\/[^/]+\/retry$/.test(path))) ||
      ((!options.method || options.method === 'GET') && [ `${API}/capabilities`, `${API}/voices` ].includes(path));
    if (usesProviders) {
      // Read the password controls at request time. Keys never enter job
      // options, manifests, upload identities or saved-game captures.
      const elevenLabsKey = String(getElevenLabsApiKey() || '').trim();
      const geminiKey = String(getGeminiApiKey() || '').trim();
      if (elevenLabsKey) headers.set('x-elevenlabs-api-key', elevenLabsKey);
      if (geminiKey) headers.set('x-gemini-api-key', geminiKey);
    }
    return headers;
  }

  async function request(path, options = {}, owner = scope(), asBlob = false) {
    assertCurrent(owner);
    const requestController = new AbortController();
    let rejectAbort, abandoned = false;
    const stopped = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => { abandoned = true; requestController.abort(); rejectAbort(abortError()); };
    owner.signal.addEventListener('abort', cancel, { once: true });
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : (asBlob ? assetTimeoutMs : requestTimeoutMs);
    const progressTransport = options.onUploadProgress && typeof XMLHttpRequestClass === 'function';
    const idleMs = progressTransport && Number(options.activityTimeoutMs) > 0 ? Number(options.activityTimeoutMs) : 0;
    const ackMs = progressTransport && Number(options.ackTimeoutMs) > 0 ? Number(options.ackTimeoutMs) : idleMs;
    let deadline, lastLoaded = 0, uploadFinished = false;
    const armDeadline = () => {
      if (deadline !== undefined) timers.clear(deadline);
      deadline = timers.set(() => {
        abandoned = true;
        const error = Object.assign(new Error(idleMs
          ? (uploadFinished
            ? 'Ses bölümü sunucuda kaydedilirken yanıt gecikti. Alınan ses kontrol edilerek devam edilecek.'
            : 'Ses aktarımında veri akışı durdu. Alınan ses korunarak bağlantı yeniden kontrol edilecek.')
          : 'Türkçe medya isteği zaman aşımına uğradı.'), { code: idleMs ? 'UPLOAD_STALLED' : 'REQUEST_TIMEOUT' });
        requestController.abort(error);
        rejectAbort(error);
      }, idleMs ? (uploadFinished ? ackMs : idleMs) : timeoutMs);
    };
    armDeadline();
    const uploadProgress = transfer => {
      if (abandoned || !current(owner)) return;
      const firstAckWait = transfer.phase === 'waiting' && !uploadFinished;
      if (firstAckWait) uploadFinished = true;
      if (idleMs && (transfer.loaded > lastLoaded || firstAckWait)) armDeadline();
      lastLoaded = Math.max(lastLoaded, Number(transfer.loaded) || 0);
      options.onUploadProgress(transfer);
    };
    try {
      const operation = (async () => {
        const address = internalUrl(path, baseUrl);
        const headers = requestHeaders(path, options);
        const response = progressTransport
          ? await requestWithUploadProgress(address, { ...options, headers, signal: requestController.signal,
            timeoutMs: idleMs ? 0 : timeoutMs, onProgress: uploadProgress, XMLHttpRequestClass })
          : await requestFetch(address, { ...options, headers, credentials: 'same-origin', signal: requestController.signal });
        const body = asBlob && response.ok ? await response.blob() : await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(errorMessage(body?.error || body?.message,
          `Türkçe medya isteği başarısız (HTTP ${response.status}).`)), { status: response.status });
        // A server may accept a job just before the browser aborts its response.
        // Cancel that late descriptor without exposing it to the new source.
        if ((abandoned || !current(owner)) && options.method === 'POST' &&
            (path === `${API}/jobs` || /\/jobs\/[^/]+\/retry$/.test(path))) {
          void cancelRemoteJob(body?.jobId || body?.id, true);
        }
        return body;
      })();
      const result = await Promise.race([operation, stopped]);
      assertCurrent(owner);
      return result;
    } finally {
      timers.clear(deadline);
      owner.signal.removeEventListener('abort', cancel);
    }
  }

  function delay(milliseconds, owner) {
    assertCurrent(owner);
    return new Promise((resolve, reject) => {
      const timer = timers.set(() => { owner.signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
      const cancel = () => { timers.clear(timer); reject(abortError()); };
      owner.signal.addEventListener('abort', cancel, { once: true });
    });
  }

  function clearCaptions() {
    overlay?.classList.add('hidden');
    if (speaker) speaker.textContent = '';
    if (text) text.textContent = '';
  }

  function renderCaptions() {
    if (sourceEmptied) { clearCaptions(); return; }
    const now = Math.max(0, (Number(video.currentTime) || 0) + syncOffset);
    const active = (tracks[subtitleTrack] || []).filter(cue => now >= cue.start && now < cue.end);
    if (!active.length) { clearCaptions(); return; }
    const label = cue => String(cue.speakerName || cue.speakerLabel || cue.speakerId || 'Konuşmacı');
    const speakerText = active.length === 1 ? label(active[0]) : '';
    const captionText = active.length === 1 ? active[0].text : active.map(cue => `${label(cue)}: ${cue.text}`).join('\n');
    if (speaker && speaker.textContent !== speakerText) speaker.textContent = speakerText;
    if (text && text.textContent !== captionText) text.textContent = captionText;
    overlay?.classList.remove('hidden');
  }

  function stopAudio() {
    audioOwnsPlayback = false;
    playVersion += 1;
    playAttempt = null;
    audio?.pause();
  }

  function restoreSourceAudio() {
    audioOwnsPlayback = false;
    if (legacySourceVolume !== null) { video.volume = legacySourceVolume; legacyAppliedVolume = legacySourceVolume; }
    if (originalMuted !== null) video.muted = originalMuted;
  }

  function applySourceAudio() {
    if (legacySourceVolume === null) { video.muted = true; return; }
    // Older saved mixes contain silence during source speech. Restore that
    // speech from the saved video locally, without retranslation or synthesis.
    const now = Number(video.currentTime) || 0;
    let gain = 0;
    for (const row of manifest?.dubSegments || []) {
      const start = row.originalSpeechStart ?? row.start, end = row.originalSpeechEnd ?? row.end;
      if (now >= start && now < end) gain = Math.max(gain, .18 * Math.min(1, (now - start) / .04, (end - now) / .08));
    }
    legacyAppliedVolume = legacySourceVolume * gain;
    if (video.volume !== legacyAppliedVolume) video.volume = legacyAppliedVolume;
    video.muted = originalMuted || gain === 0;
  }

  function canPlayAudio() {
    return dubEnabled && audio && !video.paused && !video.seeking && !video.ended &&
      !waiting && (video.readyState === undefined || video.readyState >= 3) && !playbackFailed;
  }

  function scheduleFrame() {
    if (frame !== null || !timers.frame || video.paused || video.ended || destroyed) return;
    frame = timers.frame(() => { frame = null; sync(); scheduleFrame(); });
  }

  function sync() {
    if (destroyed) return;
    renderCaptions();
    if (!audio || !dubEnabled) return;
    if (legacySourceVolume !== null && video.volume !== legacyAppliedVolume) legacySourceVolume = Number(video.volume) || 0;
    audio.volume = Math.max(0, Math.min(1, legacySourceVolume ?? (Number(video.volume) || 0)));
    audio.playbackRate = Math.max(0.01, Number(video.playbackRate) || 1);
    const target = Math.max(0, (Number(video.currentTime) || 0) + syncOffset);
    const duration = Number(audio.duration || manifest?.assets?.mix?.duration);
    const atEnd = Number.isFinite(duration) && duration > 0 && target >= duration - 0.015;
    try {
      if (needsSeek || Math.abs((Number(audio.currentTime) || 0) - target) > 0.25) {
        audio.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(target, duration) : target;
        needsSeek = false;
      }
    } catch { /* Metadata may not be available yet; loadedmetadata resynchronizes. */ }
    if (!canPlayAudio() || atEnd) { stopAudio(); return; }
    if (audioOwnsPlayback) applySourceAudio();
    if (audio.paused !== false && !playAttempt) {
      const selectedAudio = audio, owner = scope(), version = ++playVersion;
      const attempt = { owner, version };
      playAttempt = attempt;
      let playing;
      try { playing = selectedAudio.play(); }
      catch (error) { playing = Promise.reject(error); }
      Promise.resolve(playing).then(() => {
        if (!current(owner) || selectedAudio !== audio || !canPlayAudio()) selectedAudio.pause();
        else if (version === playVersion) { audioOwnsPlayback = true; applySourceAudio(); notify({ state: 'PLAYBACK_READY', jobId }); }
      }).catch(error => {
        if (!current(owner) || selectedAudio !== audio || version !== playVersion) return;
        playbackFailed = true;
        selectedAudio.pause();
        restoreSourceAudio();
        notify({ state: error?.name === 'NotAllowedError' ? 'PLAYBACK_BLOCKED' : 'PLAYBACK_FAILED',
          jobId, message: 'Türkçe ses oynatılamadı. Yeniden dene veya kaynak sese geç.', error: errorMessage(error, 'Ses açılamadı.') });
      }).finally(() => { if (playAttempt === attempt) playAttempt = null; });
    }
    scheduleFrame();
  }

  function setSubtitleTrack(value) {
    if (!['off', 'source_tr', 'dub_tr'].includes(value)) throw new Error('Altyazı kanalı geçersiz.');
    if (value !== 'off' && !tracks[value].length) value = 'off';
    subtitleTrack = value;
    renderCaptions();
    return subtitleTrack;
  }

  function setDubEnabled(value) {
    const enabled = Boolean(value);
    if (enabled && !audio) throw new Error('Türkçe ses henüz hazır değil.');
    if (enabled && !dubEnabled) {
      originalMuted = Boolean(video.muted); needsSeek = true;
      if (manifest?.qualityReport?.mix?.originalSpeechMuted === true) legacySourceVolume = legacyAppliedVolume = Number(video.volume) || 0;
    }
    if (!enabled && dubEnabled && originalMuted !== null) {
      restoreSourceAudio(); originalMuted = null; legacySourceVolume = legacyAppliedVolume = null;
    }
    dubEnabled = enabled;
    playbackFailed = false;
    if (!enabled) stopAudio();
    sync();
    return dubEnabled;
  }

  function setSyncOffset(value) {
    if (!Number.isFinite(Number(value))) throw new Error('Ses eşitleme değeri geçersiz.');
    syncOffset = Math.max(-10, Math.min(10, Number(value)));
    needsSeek = true; stopAudio(); sync();
    return syncOffset;
  }

  function releaseAudio() {
    setDubEnabled(false);
    if (audio) { audio.removeAttribute?.('src'); audio.load?.(); audio = null; }
    if (objectUrl) urlImpl.revokeObjectURL(objectUrl);
    objectUrl = null; audioBlob = null; audioBlobRequest = null;
  }

  function cancelRemoteJob(id, force = false) {
    if (!id || (!force && ['READY', 'FAILED', 'CANCELLED'].includes(jobState))) return Promise.resolve();
    const cancellation = new AbortController();
    let deadline;
    const expired = new Promise(resolve => { deadline = timers.set(() => {
      cancellation.abort(); resolve();
    }, requestTimeoutMs); });
    const sent = Promise.resolve().then(() => requestFetch(`${API}/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', credentials: 'same-origin', signal: cancellation.signal
    })).catch(() => {});
    return Promise.race([sent, expired]).finally(() => timers.clear(deadline));
  }

  function reset({ cancelJob = true } = {}) {
    const previousJob = jobId;
    const cancelled = cancelJob ? cancelRemoteJob(previousJob) : Promise.resolve();
    controller.abort(); generation += 1; controller = new AbortController();
    if (frame !== null) timers.cancelFrame?.(frame);
    frame = null;
    releaseAudio();
    manifest = null; jobId = null; jobState = null; lastStart = null;
    tracks.source_tr = []; tracks.dub_tr = [];
    subtitleTrack = 'off'; syncOffset = 0;
    waiting = false; sourceEmptied = false; playbackFailed = false;
    needsSeek = true;
    clearCaptions();
    return cancelled;
  }

  function applyManifest(value, settings = {}) {
    if (!value || value.version !== 1) throw new Error('Türkçe medya sonucu geçersiz.');
    releaseAudio();
    const safe = jsonCopy(value);
    for (const asset of Object.values(safe.assets || {})) {
      if (asset?.url) asset.url = internalUrl(asset.url, baseUrl);
    }
    if (safe.outputs?.subtitles === false || settings.subtitlesEnabled === false) safe.subtitles = { source_tr: [], dub_tr: [] };
    manifest = safe;
    tracks.source_tr = cueRows(safe.subtitles?.source_tr);
    tracks.dub_tr = cueRows(safe.subtitles?.dub_tr);
    syncOffset = Math.max(-10, Math.min(10, Number(settings.syncOffset) || 0));
    subtitleTrack = 'off';
    if (safe.assets?.mix?.url || settings.audioBlob instanceof Blob) {
      if (typeof AudioClass !== 'function') throw new Error('Bu tarayıcı Türkçe sesi oynatamıyor.');
      const selectedAudio = new AudioClass();
      const owner = scope();
      audio = selectedAudio;
      audioBlob = settings.audioBlob instanceof Blob ? settings.audioBlob : null;
      if (audioBlob) objectUrl = urlImpl.createObjectURL(audioBlob);
      selectedAudio.src = objectUrl || safe.assets.mix.url;
      selectedAudio.preload = 'auto';
      for (const event of ['loadedmetadata', 'canplay']) selectedAudio.addEventListener?.(event, () => {
        if (current(owner) && selectedAudio === audio) sync();
      });
      selectedAudio.addEventListener?.('error', () => {
        if (!current(owner) || selectedAudio !== audio) return;
        playbackFailed = true; stopAudio();
        restoreSourceAudio();
        notify({ state: 'PLAYBACK_FAILED', jobId, message: 'Türkçe ses dosyası yüklenemedi.' });
      });
      selectedAudio.load?.();
    }
    setDubEnabled(settings.dubEnabled ?? Boolean(audio));
    if (settings.subtitleTrack) setSubtitleTrack(settings.subtitleTrack);
    else if (!dubEnabled) subtitleTrack = tracks.source_tr.length ? 'source_tr' : 'off';
    renderCaptions();
    return jsonCopy(manifest);
  }

  function loadResult(value, settings = {}) {
    if (!settings.preserveJob) reset();
    if (destroyed) throw abortError();
    if (!settings.preserveJob) jobState = 'READY';
    return applyManifest(value, settings);
  }

  async function uploadSource(source, owner, timelineDuration) {
    if (!(source instanceof Blob) || !source.size || !/^audio\//i.test(source.type)) {
      throw Object.assign(new Error('Türkçe medya için yalnız ayrılmış ses yüklenebilir.'), { code: 'SOURCE_AUDIO_REQUIRED' });
    }
    if (source.size > MAX_AUDIO_BYTES) throw Object.assign(new Error('Ayrılan ses dosyası 250 MiB sınırını aşıyor.'), { code: 'SOURCE_AUDIO_TOO_LARGE' });
    const requestedChunkSize = Math.max(1, Math.min(MAX_CHUNK, Math.floor(Number(chunkSize) || AUDIO_UPLOAD_CHUNK_BYTES)));
    const fileName = String(source.name || 'source-audio.mp3').slice(0, 240);
    const timeline = Number.isFinite(timelineDuration) && timelineDuration > 0 ? timelineDuration : undefined;
    const uploadIdentity = `${timeline ?? 'container'}:chunks-${requestedChunkSize}`;
    const legacyIdentity = requestedChunkSize === AUDIO_UPLOAD_CHUNK_BYTES
      ? `${timeline ?? 'container'}:chunks-${LEGACY_AUDIO_UPLOAD_CHUNK_BYTES}` : null;
    let sourceKeys = sourceUploadKeys.get(source);
    if (!sourceKeys) { sourceKeys = new Map(); sourceUploadKeys.set(source, sourceKeys); }
    let clientUploadKey = sourceKeys.get(uploadIdentity);
    let resumeUploadKey = legacyIdentity ? sourceKeys.get(legacyIdentity) : null;
    if (!clientUploadKey) {
      // Hash bounded chunks, then their digests. Never decode or hold the whole
      // video in memory, and never identify a source by only its first frames.
      const cryptoRef = globalThis.crypto;
      if (cryptoRef?.subtle) {
        const digests = [];
        for (let offset = 0; offset < source.size; offset += MAX_CHUNK) {
          const bytes = await source.slice(offset, offset + MAX_CHUNK).arrayBuffer();
          assertCurrent(owner);
          digests.push(await cryptoRef.subtle.digest('SHA-256', bytes));
          notify({ state: 'HASHING_AUDIO', progress: { loaded: Math.min(source.size, offset + MAX_CHUNK),
            total: source.size, unit: 'bytes' }, message: 'MP3 dosyası yeniden kullanım için kontrol ediliyor.' });
        }
        const digestBytes = await new Blob(digests).arrayBuffer();
        const hash = new Uint8Array(await cryptoRef.subtle.digest('SHA-256', digestBytes));
        const fingerprint = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
        clientUploadKey = `source-audio:${source.size}:${uploadIdentity}:${fingerprint}`;
        if (legacyIdentity) resumeUploadKey = `source-audio:${source.size}:${legacyIdentity}:${fingerprint}`;
      } else {
        // An insecure browser can resume this Blob during this page session;
        // it must not reuse another source's upload through a weak fingerprint.
        clientUploadKey = `source-audio:${source.size}:${uploadIdentity}:${cryptoRef?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
      }
      assertCurrent(owner);
      sourceKeys.set(uploadIdentity, clientUploadKey);
      if (resumeUploadKey) sourceKeys.set(legacyIdentity, resumeUploadKey);
    }
    const created = await request(`${API}/uploads/start`, { method: 'POST', timeoutMs: uploadRequestTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, mimeType: source.type, totalSize: source.size,
        chunkSize: requestedChunkSize, clientUploadKey,
        ...(resumeUploadKey ? { resumeUploadKey } : {}),
        ...(timeline ? { timelineDuration: timeline } : {}) }) }, owner);
    const uploadId = created.uploadId || created.id;
    if (!uploadId) throw new Error('Video yükleme kimliği alınamadı.');
    const size = Math.max(1, Math.min(MAX_CHUNK, Number(created.chunkSize) || requestedChunkSize));
    const total = Math.ceil(source.size / size);
    let status = await request(`${API}/uploads/${encodeURIComponent(uploadId)}/status`, { timeoutMs: uploadRequestTimeoutMs }, owner);
    const completed = body => new Set((body.completedChunks || body.receivedChunks || body.chunks || [])
      .filter(entry => typeof entry === 'number' || entry?.complete || entry?.completed)
      .map(entry => typeof entry === 'number' ? entry : Number(entry.index ?? entry.chunkIndex)));
    let done = completed(status);
    const acknowledgedBytes = () => [...done].reduce((sum, index) =>
      sum + Math.min(size, source.size - index * size), 0);
    notify({ state: 'UPLOADING', progress: { loaded: acknowledgedBytes(), total: source.size, unit: 'bytes' },
      message: created.reused ? 'Önceden gönderilmiş MP3 kontrol ediliyor.' : 'MP3 gönderiliyor.' });
    for (let index = 0; index < total; index++) {
      assertCurrent(owner);
      if (!done.has(index)) {
        const chunk = source.slice(index * size, Math.min(source.size, (index + 1) * size));
        for (let attempt = 0; ; attempt++) {
          try {
            await request(`${API}/uploads/${encodeURIComponent(uploadId)}/chunk/${index}`, {
              method: 'POST', timeoutMs: uploadRequestTimeoutMs,
              activityTimeoutMs: uploadIdleTimeoutMs, ackTimeoutMs: uploadAckTimeoutMs,
              onUploadProgress: transfer => {
                if (!current(owner)) return;
                notify({ state: 'UPLOADING', waiting: transfer.phase === 'waiting',
                  progress: { loaded: Math.min(source.size, acknowledgedBytes() + Math.min(chunk.size, transfer.loaded)),
                    total: source.size, unit: 'bytes' },
                  message: transfer.phase === 'waiting' ? 'Gönderilen ses bölümü kaydediliyor.' : 'MP3 gönderiliyor.' });
              },
              headers: { 'Content-Type': 'application/octet-stream' }, body: chunk }, owner);
            break;
          } catch (error) {
            if (!current(owner) || error.name === 'AbortError' || attempt >= 2 ||
                (error.status && error.status < 500 && ![408,429].includes(error.status))) throw error;
            notify({ state: 'UPLOADING', waiting: true, progress: { loaded: acknowledgedBytes(), total: source.size, unit: 'bytes' },
              message: 'Bağlantı yeniden kontrol ediliyor; alınan ses korunuyor, yalnız eksik bölüm gönderilecek.' });
            await delay(retryDelayMs * (attempt + 1), owner);
            status = await request(`${API}/uploads/${encodeURIComponent(uploadId)}/status`, { timeoutMs: uploadRequestTimeoutMs }, owner);
            done = completed(status);
            if (done.has(index)) break;
          }
        }
      }
      done.add(index);
      notify({ state: 'UPLOADING', progress: { percent: Math.floor(acknowledgedBytes() / source.size * 100),
          loaded: acknowledgedBytes(), total: source.size, unit: 'bytes' }, lastServerContactAt: timers.now(),
        message: 'Gönderilen ses sunucu tarafından kaydedildi.' });
    }
    return uploadId;
  }

  function reportFailure(error, owner) {
    if (current(owner) && error.name !== 'AbortError') notify({ state: 'FAILED', jobId, message: error.message,
      error: { code: error.code || 'TURKISH_MEDIA_FAILED', message: error.message } });
  }

  async function pollJob(created, selected, owner, previousId) {
    jobId = created.jobId || created.id || previousId;
    if (!jobId) throw new Error('Türkçe medya işi oluşturulamadı.');
    jobState = 'QUEUED';
    const statusUrl = internalUrl(created.statusUrl || `${API}/jobs/${encodeURIComponent(jobId)}`, baseUrl);
    const startedAt = timers.now();
    let failures = 0;
    while (current(owner)) {
      let status;
      try { status = await request(statusUrl, {}, owner); failures = 0; }
      catch (error) {
        if (!current(owner) || error.name === 'AbortError' ||
            (error.status && error.status < 500 && ![408,429].includes(error.status))) throw error;
        if (failures >= 5) throw Object.assign(new Error('Sunucu bağlantısı kesildi. Yeniden dene ile mevcut işlemin durumunu kontrol edebilirsin.'),
          { code: 'MEDIA_CONNECTION_LOST', cause: error });
        failures += 1;
        notify({ state: 'RECONNECTING', jobId, message: 'Bağlantı yeniden kuruluyor; mevcut iş sunucuda kontrol ediliyor.' });
        await delay(retryDelayMs * failures, owner);
        continue;
      }
      jobState = String(status.state || status.status || '').toUpperCase();
      const result = status.result || status.manifest;
      notify({ jobId, origin: 'server', state: jobState, progress: status.progress,
        stageProgress: status.stageProgress, completedStages: status.completedStages,
        updatedAt: status.updatedAt, lastServerContactAt: timers.now(), waiting: !status.stageProgress,
        transcriptOnly: selected.options.outputs.transcriptOnly === true, message: status.message,
        error: status.error, sourceTranscript: status.sourceTranscript || result?.sourceTranscript });
      if (jobState === 'READY') {
        assertCurrent(owner);
        return applyManifest(result, { dubEnabled: selected.options.outputs.dub && Boolean(result?.assets?.mix),
          subtitleTrack: selected.options.outputs.subtitles
            ? (selected.options.outputs.dub ? 'dub_tr' : 'source_tr') : 'off' });
      }
      if (jobState === 'FAILED') throw Object.assign(new Error(errorMessage(status.error,
        status.message || 'Türkçe medya hazırlanamadı.')), { code: status.error?.code || 'JOB_FAILED' });
      if (jobState === 'CANCELLED') throw abortError();
      if (timers.now() - startedAt > maxJobWaitMs) throw new Error('Türkçe medya işi zamanında tamamlanamadı.');
      await delay(pollIntervalMs, owner);
    }
    throw abortError();
  }

  async function start(source, options = {}) {
    if (destroyed) throw abortError();
    reset();
    const owner = scope();
    lastStart = { source, options: { outputs: { dub: options.outputs?.dub !== false,
      subtitles: options.outputs?.subtitles !== false, ...(options.outputs?.transcriptOnly ? { transcriptOnly: true } : {}) },
      qualityMode: String(options.qualityMode || 'quality'),
      voiceMapping: jsonCopy(options.voiceMapping || {}),
      previousVoiceMapping: jsonCopy(options.previousVoiceMapping || {}),
      sceneContext: jsonCopy(Array.isArray(options.sceneContext) ? options.sceneContext : []),
      ...(options.speakerHints && Object.keys(options.speakerHints).length
        ? { speakerHints: jsonCopy(options.speakerHints) } : {}) } };
    const selected = lastStart;
    try {
      if (!/^audio\//i.test(source?.type || '')) {
        notify({ origin: 'device', phase: 'extracting', state: 'PREPARING_AUDIO', progress: { percent: 0 }, message: 'Videodan ses cihazda ayrılıyor.' });
      }
      const audioSource = await prepareSourceAudio(source, { signal: owner.signal, duration: video.duration,
        onProgress: ({ phase, loaded = 0, total = 0, bytes }) => {
          if (!current(owner)) return;
          const mp3 = ['loading_encoder', 'decoding', 'encoding', 'finalizing_mp3', 'mp3_ready', 'cached'].includes(phase);
          notify({ origin: 'device', phase, state: mp3 ? 'ENCODING_MP3' : 'PREPARING_AUDIO',
            progress: { loaded, total, ...(total ? { percent: Math.floor(loaded / total * 100) } : {}),
              unit: mp3 ? 'percent' : 'bytes', bytes },
            message: phase === 'cached' ? 'Önceden hazırlanan MP3 kullanılıyor.' : phase === 'loading_encoder'
              ? 'Telefonda MP3 dönüştürücüsü hazırlanıyor.' : phase === 'decoding' ? 'Ses kanalı MP3 için çözülüyor.'
              : phase === 'index' ? 'Videonun ses kanalı bulunuyor.' : phase === 'encoding'
              ? 'Ses MP3’e dönüştürülüyor.' : phase === 'finalizing_mp3' ? 'MP3 dosyası tamamlanıyor.'
              : phase === 'mp3_ready' ? 'MP3 dosyası hazır.' : 'Ses kanalı cihazda ayrılıyor.' });
        } });
      assertCurrent(owner);
      notify({ state: 'HASHING_AUDIO', progress: { loaded: 0, total: audioSource.size, unit: 'bytes' }, message: 'MP3 dosyası ve önceki aktarım kontrol ediliyor.' });
      const uploadId = await uploadSource(audioSource, owner, Number(video.duration));
      const created = await request(`${API}/jobs`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId, ...selected.options }) }, owner);
      return await pollJob(created, selected, owner);
    } catch (error) {
      if (error.status === 404 && jobId && current(owner)) {
        error = Object.assign(new Error('Sunucudaki medya işi kayboldu. Yeniden dene yeni bir işlem açar ve API kredisi kullanabilir.'), {
          status: 404, code: 'MEDIA_JOB_LOST'
        });
      }
      reportFailure(error, owner);
      throw error;
    }
  }

  async function retry() {
    if (destroyed) throw abortError();
    if (!lastStart) throw new Error('Yeniden başlatılacak Türkçe medya işi yok.');
    const selected = lastStart, previousId = jobId;
    if (!previousId) return start(selected.source, selected.options);
    if (jobState === 'READY') throw new Error('Bu Türkçe medya işi zaten hazır.');
    const restart = ['FAILED', 'CANCELLED'].includes(jobState);
    reset({ cancelJob: false }); lastStart = selected;
    const owner = scope();
    notify({ state: 'QUEUED', message: 'Türkçe medya işlemi yeniden başlatılıyor.' });
    try {
      // A lost polling connection resumes the existing running job. Only a
      // terminal provider failure invokes the backend's explicit retry route.
      const created = restart
        ? await request(`${API}/jobs/${encodeURIComponent(previousId)}/retry`, { method: 'POST' }, owner)
        : { jobId: previousId };
      return await pollJob(created, selected, owner, previousId);
    } catch (error) {
      if (error.status === 404 && current(owner)) {
        notify({ state: 'RECONNECTING', message: 'Önceki iş sunucuda bulunamadı; ses yeniden aktarılıyor.' });
        return start(selected.source, selected.options);
      }
      reportFailure(error, owner);
      throw error;
    }
  }

  async function materializeAudio() {
    if (audioBlob) return audioBlob;
    if (!manifest?.assets?.mix?.url) return null;
    if (!audioBlobRequest) {
      const owner = scope(), url = manifest.assets.mix.url;
      const pending = request(url, {}, owner, true).then(blob => {
        if (!(blob instanceof Blob) || !blob.size || (blob.type && !/^audio\//.test(blob.type))) {
          throw new Error('Kaydedilecek Türkçe ses dosyası geçersiz.');
        }
        assertCurrent(owner); audioBlob = blob;
        // The saved bytes also own playback. Do not keep seeking a remote asset
        // after it has been downloaded once, or after the server goes to sleep.
        if (audio) {
          stopAudio(); restoreSourceAudio();
          const previousUrl = objectUrl;
          objectUrl = urlImpl.createObjectURL(blob);
          audio.src = objectUrl; audio.load?.(); needsSeek = true; playbackFailed = false;
          if (previousUrl) urlImpl.revokeObjectURL(previousUrl);
          sync();
        }
        return blob;
      }).finally(() => { if (audioBlobRequest === pending) audioBlobRequest = null; });
      audioBlobRequest = pending;
    }
    return audioBlobRequest;
  }

  function conversationEndAt(time, source = [], duration = Infinity) {
    return conversationEnd(time, source, manifest?.dubSegments || [], { dubEnabled, offset: syncOffset, duration });
  }

  function capture() {
    return manifest ? jsonCopy({ manifest, dubEnabled, subtitleTrack, syncOffset }) : null;
  }

  const onMedia = event => {
    if (['waiting', 'stalled', 'seeking'].includes(event.type)) { waiting = true; stopAudio(); }
    if (['playing', 'canplay', 'loadeddata', 'loadedmetadata', 'seeked'].includes(event.type)) waiting = Number(video.readyState) < 3;
    if (['playing', 'canplay', 'loadeddata', 'loadedmetadata'].includes(event.type)) sourceEmptied = false;
    if (event.type === 'seeked') needsSeek = true;
    if (['pause', 'ended', 'emptied', 'error'].includes(event.type)) stopAudio();
    if (['emptied', 'error'].includes(event.type)) waiting = true;
    if (event.type === 'emptied') sourceEmptied = true;
    if (event.type === 'error') {
      playbackFailed = true;
      notify({ state: 'PLAYBACK_FAILED', jobId, message: 'Kaynak video oynatılamadı; Türkçe ses durduruldu.' });
    }
    if (event.type === 'emptied') clearCaptions();
    else sync();
    if (video.paused || video.ended) { if (frame !== null) timers.cancelFrame?.(frame); frame = null; }
    else scheduleFrame();
  };
  const events = ['timeupdate', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked',
    'canplay', 'loadeddata', 'loadedmetadata', 'ratechange', 'volumechange', 'ended', 'emptied', 'error'];
  events.forEach(event => video.addEventListener(event, onMedia));
  clearCaptions();
  return { start, loadResult, setDubEnabled, setSubtitleTrack, setSyncOffset, sync, reset, capture, conversationEndAt, materializeAudio,
    getCapabilities: () => request(`${API}/capabilities`),
    async getVoices() {
      const body = await request(`${API}/voices`);
      const rows = Array.isArray(body) ? body : body.voices;
      if (!Array.isArray(rows)) throw new Error('Konuşmacı ses listesi geçersiz.');
      return rows.filter(row => typeof row?.voiceId === 'string' && row.voiceId)
        .map(row => ({ voiceId: row.voiceId, name: String(row.name || row.voiceId),
          gender: ['male', 'female'].includes(row.gender) ? row.gender : 'uncertain',
          language: typeof row.language === 'string' ? row.language : '' }));
    },
    retryPlayback() { playbackFailed = false; sync(); },
    cancel: reset, retry,
    destroy() { if (destroyed) return; reset(); destroyed = true;
      events.forEach(event => video.removeEventListener(event, onMedia)); }
  };
}
