// Scene metadata can include a distant post-roll time. Leaving a scene must
// resume at its actual boundary, so intervening source footage is preserved.
export function sceneExitTime(endTime, duration) {
  const end = Math.max(0, Number(endTime) || 0);
  const limit = Number(duration);
  return Number.isFinite(limit) && limit > 0 ? Math.min(end, limit) : end;
}

export function hasRemainingVideo(currentTime, duration) {
  const end = Number(duration);
  return Number.isFinite(end) && end > 0 && Number(currentTime) < end - 0.05;
}

// A failed analysis interval has no safe interactive choices. Keep the source
// video moving through that interval and hand control back at the first later
// verified route. Returning the media duration lets playback finish normally
// when the failed interval is followed by no more verified routes.
export function analysisGapBridgeTarget(gaps, currentTime, routeTimes, duration) {
  const cursor = Math.max(0, Number(currentTime) || 0);
  const mediaEnd = Number(duration);
  const routes = (Array.isArray(routeTimes) ? routeTimes : [])
    .map(Number)
    .filter(time => Number.isFinite(time) && time > cursor + 0.05)
    .sort((left, right) => left - right);
  const target = routes[0] ?? (Number.isFinite(mediaEnd) && mediaEnd > cursor + 0.05 ? mediaEnd : null);
  if (target === null) return null;

  const crossesGap = (Array.isArray(gaps) ? gaps : []).some(gap => {
    const start = Number(gap?.startTime);
    const end = Number(gap?.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start &&
      end > cursor + 0.05 && start < target + 0.05;
  });
  return crossesGap ? target : null;
}

const pendingMediaSeeks = new WeakMap();
const pendingMediaPlays = new WeakMap();

// play() may remain pending indefinitely while buffering. Bound that wait and
// require actual media readiness; a stale promise must never resume an old UI.
export function playMedia(video, { signal, timeoutMs = 12000 } = {}) {
  pendingMediaPlays.get(video)?.();
  return new Promise((resolve, reject) => {
    let timer, poll, settled = false, started = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error && error.name !== 'AbortError' && pendingMediaPlays.get(video) === aborted) video.pause?.();
      clearTimeout(timer); clearInterval(poll);
      video.removeEventListener('playing', playing);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      if (pendingMediaPlays.get(video) === aborted) pendingMediaPlays.delete(video);
      error ? reject(error) : resolve();
    };
    const ready = () => { if (started && !video.paused && !video.seeking && video.readyState >= 2) finish(); };
    const playing = () => { started = true; ready(); };
    const failed = () => finish(new Error('Video oynatılamadı. Yeniden deneyebilirsin.'));
    const aborted = () => finish(new DOMException('Oynatma iptal edildi.', 'AbortError'));
    if (signal?.aborted) return aborted();
    pendingMediaPlays.set(video, aborted);
    signal?.addEventListener('abort', aborted, { once: true });
    video.addEventListener('playing', playing);
    video.addEventListener('error', failed);
    timer = setTimeout(() => finish(new Error('Video yüklenmesi zaman aşımına uğradı. Devam etmek için yeniden dene.')), timeoutMs);
    poll = setInterval(ready, 100);
    try { Promise.resolve(video.play()).then(playing, finish); }
    catch (error) { finish(error); }
  });
}

export function seekMediaTo(video, requestedTime, { signal, timeoutMs = 8000 } = {}) {
  pendingMediaPlays.get(video)?.();
  pendingMediaSeeks.get(video)?.();
  const target = sceneExitTime(requestedTime, video.duration);
  return new Promise((resolve, reject) => {
    let timer;
    let poll;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onSeeked);
      video.removeEventListener('canplay', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (pendingMediaSeeks.get(video) === onAbort) pendingMediaSeeks.delete(video);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(target);
    };
    const atTarget = () => !video.seeking && video.readyState >= 2 &&
      Math.abs(Number(video.currentTime) - target) <= 0.08;
    const onSeeked = () => { if (atTarget()) finish(); };
    const onError = () => finish(new Error('Video konumu yüklenemedi. Tekrar deneyebilirsin.'));
    const onAbort = () => finish(new DOMException('Geçiş iptal edildi.', 'AbortError'));
    if (signal?.aborted) return onAbort();
    pendingMediaSeeks.set(video, onAbort);
    if (atTarget()) return finish();
    // Listen first, including for synchronous/same-frame seek completion.
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadeddata', onSeeked);
    video.addEventListener('canplay', onSeeked);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (atTarget()) finish();
      else finish(new Error('Video konumu beklenen sürede yüklenemedi. Tekrar deneyebilirsin.'));
    }, timeoutMs);
    // Some decoders omit seeked when reusing a buffered frame. Readiness and
    // the requested media time must both be satisfied before continuing.
    poll = setInterval(onSeeked, 100);
    try { video.currentTime = target; }
    catch (error) { finish(error); }
  });
}

export function canvasBlob(canvas, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new DOMException('İşlem iptal edildi.', 'AbortError'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Karelerin görüntüye dönüştürülmesi zaman aşımına uğradı. Yeniden deneyebilirsin.')), timeoutMs);
    try {
      canvas.toBlob(value => finish(value ? null : new Error('Storyboard oluşturulamadı.'), value), 'image/jpeg', 0.6);
    } catch (error) { finish(error); }
  });
}

export function isCompleteChunkAnalysis({ completedChunkCount = 0, expectedChunkCount = 0, failed = false } = {}) {
  const completed = Math.max(0, Math.floor(Number(completedChunkCount) || 0));
  const expected = Math.max(0, Math.floor(Number(expectedChunkCount) || 0));
  return !failed && expected > 0 && completed === expected;
}
