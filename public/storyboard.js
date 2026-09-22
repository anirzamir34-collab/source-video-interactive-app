import { canvasBlob, seekMediaTo } from './playback-logic.js';

export function detectSceneBoundaries(motionProfile = [], interval = 1) {
  const samples = Array.isArray(motionProfile)
    ? motionProfile.filter(item => Number.isFinite(Number(item?.time)) && Number.isFinite(Number(item?.score)))
    : [];
  const minimumGap = Math.max(2.5, Number(interval || 1) * 2);
  const boundaries = [];
  let lastBoundary = -Infinity;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const next = samples[index + 1];
    const score = Number(current.score);
    const rise = score - Number(previous.score);
    const localPeak = !next || score >= Number(next.score);
    const meaningfulChange = score >= 48 || (score >= 34 && rise >= 12);
    const time = Number(current.time);

    if (meaningfulChange && localPeak && time - lastBoundary >= minimumGap) {
      boundaries.push({
        time: Number(time.toFixed(3)),
        score,
        kind: score >= 48 ? 'hard-cut' : 'visual-transition'
      });
      lastBoundary = time;
    }
  }

  return boundaries;
}

export function sheetsPerAnalysisChunk(qualityMode = 'ultra', remote = false) {
  // Adaptive remote sampling makes one 12-frame sheet span roughly 45–60
  // seconds. Analyze it alone so brief positions and partner transitions are
  // not compressed into a single 150-second model request.
  if (remote) return 1;
  const mode = String(qualityMode || 'ultra').toLowerCase();
  if (mode === 'fast') return 4;
  return 3;
}

export function adaptiveAnalysisChunkPlan(sheetCount = 0, duration = 0, qualityMode = 'ultra') {
  const sheets = Math.max(1, Math.floor(Number(sheetCount) || 1));
  const seconds = Math.max(1, Number(duration) || 1);
  const fast = String(qualityMode || 'ultra').toLowerCase() === 'fast';
  // Model calls scale with the source duration, not with a dense patch of
  // focused frames. Short videos should never pay the long-video ceiling.
  const targetSeconds = fast ? 125 : 95;
  const durationCeiling = seconds <= 180 ? 3
    : seconds <= 480 ? 6
      : seconds <= 900 ? 10
        : seconds <= 1800 ? 12 : seconds <= 2400 ? 15 : 20;
  const chunkCount = Math.min(sheets, durationCeiling, Math.max(1, Math.ceil(seconds / targetSeconds)));
  // Partition by cumulative boundaries. Rounding a single group size up
  // reduced 19 sheets / 15 requested chapters to only 10 actual chapters.
  const chunks = Array.from({ length: chunkCount }, (_, index) => {
    const firstSheet = Math.floor(index * sheets / chunkCount);
    return { firstSheet, sheetCount: Math.floor((index + 1) * sheets / chunkCount) - firstSheet };
  });
  return { sheetsPerChunk: Math.ceil(sheets / chunkCount), chunkCount, chunks };
}

export function storyboardSamplingPlan(duration, remote = false) {
  const seconds = Math.max(0, Number(duration) || 0);
  if (!remote) {
    return {
      baseCount: seconds <= 300 ? 144 : seconds <= 900 ? 192 : 228,
      focusedCount: 0
    };
  }

  // A remote seek can require a separate range request and keyframe decode.
  // Scale the work continuously with duration so a five-minute source no
  // longer costs almost the same as a ten-minute source. Broad probes are
  // approximately six seconds apart; a smaller adaptive budget is then spent
  // only around motion and scene changes.
  const baseCount = Math.min(160, Math.max(36, Math.ceil(seconds / 6)));
  return {
    baseCount,
    focusedCount: Math.max(12, Math.round(baseCount * 0.35))
  };
}

export function selectFocusedTimestamps(profile = [], duration = 0, limit = 0) {
  const samples = Array.isArray(profile)
    ? profile.filter(item => Number.isFinite(Number(item?.time)))
    : [];
  const maximum = Math.max(0, Math.floor(Number(limit) || 0));
  if (samples.length < 2 || !maximum) return [];

  const candidates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const start = Number(previous.time);
    const end = Number(current.time);
    const gap = end - start;
    if (!(gap > 0.4)) continue;

    const currentScore = Number(current.score) || 0;
    const previousScore = Number(previous.score) || 0;
    const priority = Math.max(currentScore, previousScore) +
      Math.abs(currentScore - previousScore) * 0.75;
    candidates.push({ time: start + gap / 2, priority });

    // Very active intervals get two extra probes. This is where a brief
    // position/action change is most likely to sit between the broad samples.
    if (priority >= 36) {
      candidates.push({ time: start + gap / 3, priority: priority - 0.1 });
      candidates.push({ time: start + gap * 2 / 3, priority: priority - 0.2 });
    }
  }

  const selected = [];
  const safeDuration = Math.max(0, Number(duration) || 0);
  const rankedCandidates = candidates.sort((a, b) => b.priority - a.priority);
  const focusedLimit = Math.max(1, Math.floor(maximum * 0.75));
  for (const candidate of rankedCandidates) {
    const time = Math.min(Math.max(0, candidate.time), Math.max(0, safeDuration - 0.05));
    const duplicatesBase = samples.some(item => Math.abs(Number(item.time) - time) < 0.3);
    const duplicatesSelected = selected.some(value => Math.abs(value - time) < 0.3);
    if (!duplicatesBase && !duplicatesSelected) selected.push(time);
    if (selected.length >= focusedLimit) break;
  }

  // Reserve part of the budget for evenly distributed midpoints. A quiet or
  // gradually changing short scene should not be missed merely because its
  // motion score is lower than the busiest section of the video.
  const chronological = candidates.slice().sort((a, b) => a.time - b.time);
  const remaining = maximum - selected.length;
  for (let index = 0; index < remaining && chronological.length; index += 1) {
    const candidateIndex = Math.min(
      chronological.length - 1,
      Math.floor(((index + 0.5) / remaining) * chronological.length)
    );
    const time = Math.min(
      Math.max(0, chronological[candidateIndex].time),
      Math.max(0, safeDuration - 0.05)
    );
    const duplicate = samples.some(item => Math.abs(Number(item.time) - time) < 0.3) ||
      selected.some(value => Math.abs(value - time) < 0.3);
    if (!duplicate) selected.push(time);
  }

  return selected.sort((a, b) => a - b).map(time => Number(time.toFixed(3)));
}

export function shouldBufferStoryboardSource({ sourceBytes, seekAttempts, seekMs, remainingFrames } = {}) {
  // Only replace demonstrably slow range access with one bounded, exact-byte
  // download. Fast streams and large/unknown-size videos stay streamed.
  const bytes = Number(sourceBytes) || 0;
  if (bytes <= 0 || bytes > 128 * 1024 * 1024 || remainingFrames < 12) return false;
  const averageMs = seekMs / Math.max(1, seekAttempts);
  return seekMs >= 5000 && averageMs >= 1800 && averageMs * remainingFrames >= 30000;
}

export async function extractStoryboard(source, onProgress = () => {}, signal, options = {}) {
  const startedAt = performance.now();
  const ownsObjectUrl = source instanceof Blob;
  const url = ownsObjectUrl ? URL.createObjectURL(source) : String(source || '');
  const remoteSampling = options.remoteSampling ?? !ownsObjectUrl;
  if (!url) throw new Error('Video kaynağı bulunamadı.');
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  const capturedFrames = [];
  let bufferedUrl = '';
  let bufferAttempted = ownsObjectUrl;
  const timings = { metadataMs: 0, seekMs: 0, maxSeekMs: 0, seekAttempts: 0, retries: 0, bufferMs: 0, encodeMs: 0, sourceMode: ownsObjectUrl ? 'local' : 'remote' };

  const wait = (event, timeoutMs = 15000, trigger = null) => new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener(event, complete);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', abort);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`Video ${event} sırasında okunamadı.`));
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('İşlem iptal edildi', 'AbortError'));
    };
    const timeout = () => {
      cleanup();
      const error = new Error(`Video ${event} zaman aşımına uğradı.`);
      error.name = 'VideoFrameTimeoutError';
      reject(error);
    };
    if (signal?.aborted) return abort();
    video.addEventListener(event, complete, { once: true });
    video.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(timeout, timeoutMs);
    if (!trigger && event === 'loadedmetadata' && video.readyState >= 1) return complete();
    try {
      trigger?.();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

  try {
    await wait('loadedmetadata', 30000);
    timings.metadataMs = Math.round(performance.now() - startedAt);

    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Video süresi okunamadı.');
    }

    const samplingPlan = storyboardSamplingPlan(duration, remoteSampling);
    const targetFrameCount = samplingPlan.baseCount;
    const interval = Math.max(0.75, duration / targetFrameCount);
    const times = [];
    for (let time = 0; time < duration; time += interval) times.push(time);
    let plannedFrames = times.length + samplingPlan.focusedCount;
    const report = (progress, detail = {}) => onProgress(progress, {
      captured: capturedFrames.length,
      total: plannedFrames,
      elapsedSeconds: (performance.now() - startedAt) / 1000,
      sourceMode: timings.sourceMode,
      phase: 'capture',
      ...detail
    });

    const tryBufferedSource = async (progress, time) => {
      if (bufferAttempted || typeof options.getLocalSource !== 'function' || !shouldBufferStoryboardSource({
        sourceBytes: options.sourceBytes,
        seekAttempts: timings.seekAttempts,
        seekMs: timings.seekMs,
        remainingFrames: plannedFrames - capturedFrames.length
      })) return false;
      bufferAttempted = true;
      const bufferStartedAt = performance.now();
      report(progress, { phase: 'buffering', time });
      try {
        const blob = await options.getLocalSource({
          signal,
          maxBytes: 128 * 1024 * 1024,
          maxDurationMs: Math.min(45000, Math.max(15000,
            timings.seekMs / Math.max(1, timings.seekAttempts) * (plannedFrames - capturedFrames.length) / 2)),
          onProgress: transfer => report(progress, { phase: 'buffering', time, transfer })
        });
        if (signal?.aborted) throw new DOMException('İşlem iptal edildi', 'AbortError');
        if (!(blob instanceof Blob) || !blob.size) throw new Error('Geçici video boş geldi.');
        bufferedUrl = URL.createObjectURL(blob);
        await wait('loadedmetadata', 30000, () => {
          video.src = bufferedUrl;
          video.preload = 'auto';
          video.load();
        });
        // Switching transport must never switch the underlying timeline.
        if (!Number.isFinite(Number(video.duration)) || Math.abs(Number(video.duration) - duration) > 0.1) throw new Error('Video süresi değişti.');
        options.onBufferedSource?.(blob);
        timings.sourceMode = 'buffered';
        return true;
      } catch (error) {
        if (signal?.aborted) throw error;
        timings.bufferFailure = String(error?.message || error);
        if (bufferedUrl) {
          await wait('loadedmetadata', 30000, () => {
            video.src = url;
            video.preload = 'auto';
            video.load();
          });
          URL.revokeObjectURL(bufferedUrl);
          bufferedUrl = '';
        }
        report(progress, { phase: 'capture', time, bufferingFailed: true });
        return false;
      } finally {
        timings.bufferMs += Math.round(performance.now() - bufferStartedAt);
      }
    };

    const columns = 3;
    const rows = 4;
    const framesPerSheet = columns * rows;
    const cellWidth = 320;
    const ratio = (video.videoHeight || 9) / (video.videoWidth || 16);
    const cellHeight = Math.max(180, Math.round(cellWidth * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = columns * cellWidth;
    canvas.height = rows * cellHeight;
    const ctx = canvas.getContext('2d', { alpha: false });

    if (!ctx) throw new Error('Canvas kullanılamıyor.');

    const sheets = [];
    const timestamps = [];
    let sheetFrame = 0;

    const finishSheet = async () => {
      if (!sheetFrame) return;
      const encodeStartedAt = performance.now();
      const blob = await canvasBlob(canvas, { signal });
      timings.encodeMs += performance.now() - encodeStartedAt;
      sheets.push(blob);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      sheetFrame = 0;
    };

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const motionCanvas = document.createElement('canvas');
    motionCanvas.width = 64;
    motionCanvas.height = 36;
    const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
    if (!motionCtx) throw new Error('Hareket analizi başlatılamadı.');
    const skippedTimestamps = [];

    const captureFrame = async (time, progress) => {
      if (signal?.aborted) throw new DOMException('İşlem iptal edildi', 'AbortError');

      const safeTime = Math.min(time, Math.max(0, duration - 0.05));
      const seekStartedAt = performance.now();
      timings.seekAttempts += 1;
      try {
        await seekMediaTo(video, safeTime, { signal, timeoutMs: ownsObjectUrl || bufferedUrl ? 10000 : 15000 });
      } finally {
        const elapsed = performance.now() - seekStartedAt;
        timings.seekMs += elapsed;
        timings.maxSeekMs = Math.max(timings.maxSeekMs, elapsed);
      }

      const snapshot = document.createElement('canvas');
      snapshot.width = cellWidth;
      snapshot.height = cellHeight;
      const snapshotCtx = snapshot.getContext('2d', { alpha: false });
      if (!snapshotCtx) throw new Error('Video karesi hazırlanamadı.');
      snapshotCtx.drawImage(video, 0, 0, cellWidth, cellHeight);

      motionCtx.drawImage(snapshot, 0, 0, 64, 36);
      capturedFrames.push({
        time: Number(safeTime.toFixed(3)),
        snapshot,
        motionPixels: new Uint8ClampedArray(
          motionCtx.getImageData(0, 0, 64, 36).data
        )
      });
      report(Math.min(84, Math.max(1, Math.round(progress))), { time: safeTime });
    };

    let consecutiveFailures = 0;
    const captureFrameSafely = async (time, progress) => {
      await tryBufferedSource(progress, time);
      const retryOffsets = [0, 0.12, -0.12];
      let lastError = null;
      for (let attempt = 0; attempt < retryOffsets.length; attempt += 1) {
        const offset = retryOffsets[attempt];
        const retryTime = Math.min(
          Math.max(0, Number(time) + offset),
          Math.max(0, duration - 0.05)
        );
        try {
          report(Math.min(84, Math.max(1, Math.round(progress))), {
            time: retryTime, retrying: offset !== 0
          });
          await captureFrame(retryTime, progress);
          consecutiveFailures = 0;
          return true;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          if (error?.name === 'SecurityError') throw error;
          if (video.error) throw new Error('Video kaynağı okunamıyor. Bağlantıyı veya dosya biçimini kontrol edip yeniden dene.');
          lastError = error;
          timings.retries += 1;
          if (await tryBufferedSource(progress, time)) {
            // Retry the exact timestamp before applying any decode offsets.
            retryOffsets.splice(attempt + 1, 0, 0);
          }
        }
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        throw new Error('Arka arkaya üç video karesi yüklenemedi. Hazırlama durduruldu; bağlantıyı kontrol edip yeniden deneyebilirsin.');
      }
      skippedTimestamps.push({
        time: Number(Number(time).toFixed(3)),
        reason: lastError?.message || 'Video karesi okunamadı.'
      });
      // A single undecodable/range-unavailable frame must not leave the whole
      // mobile analysis waiting forever. Progress still advances and the
      // remaining verified frames continue to the external analyzer.
      report(Math.min(84, Math.max(1, Math.round(progress))), { time });
      return false;
    };

    for (let index = 0; index < times.length; index += 1) {
      await captureFrameSafely(times[index], ((index + 1) / times.length) * 58);
    }

    if (capturedFrames.length < Math.min(12, Math.ceil(times.length * 0.25))) {
      throw new Error(
        `Video karelerinin çoğu okunamadı (${capturedFrames.length}/${times.length}). ` +
        'Video bağlantısını veya dosya biçimini kontrol et.'
      );
    }

    const buildMotionProfile = frames => {
      let previousMotionPixels = null;
      return frames.map(frame => {
        let score = 0;
        if (previousMotionPixels) {
          let difference = 0;
          let comparisons = 0;
          for (let pixel = 0; pixel < frame.motionPixels.length; pixel += 16) {
            difference +=
              Math.abs(frame.motionPixels[pixel] - previousMotionPixels[pixel]) +
              Math.abs(frame.motionPixels[pixel + 1] - previousMotionPixels[pixel + 1]) +
              Math.abs(frame.motionPixels[pixel + 2] - previousMotionPixels[pixel + 2]);
            comparisons += 1;
          }
          score = Math.min(100, Math.round(difference / Math.max(1, comparisons) / 7.65));
        }
        previousMotionPixels = frame.motionPixels;
        return {
          time: Number(frame.time.toFixed(2)),
          score,
          level: score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low'
        };
      });
    };

    let motionProfile = buildMotionProfile(capturedFrames);
    const focusedTimes = selectFocusedTimestamps(
      motionProfile,
      duration,
      samplingPlan.focusedCount
    );
    plannedFrames = times.length + focusedTimes.length;
    for (let index = 0; index < focusedTimes.length; index += 1) {
      await captureFrameSafely(
        focusedTimes[index],
        58 + ((index + 1) / Math.max(1, focusedTimes.length)) * 26
      );
    }

    capturedFrames.sort((a, b) => a.time - b.time);
    motionProfile = buildMotionProfile(capturedFrames);

    for (let index = 0; index < capturedFrames.length; index += 1) {
      const { time, snapshot } = capturedFrames[index];

      const column = sheetFrame % columns;
      const row = Math.floor(sheetFrame / columns);
      const x = column * cellWidth;
      const y = row * cellHeight;

      ctx.drawImage(snapshot, x, y, cellWidth, cellHeight);
      snapshot.width = 0;
      snapshot.height = 0;
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(x + 6, y + 6, 92, 28);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`${time.toFixed(1)}s`, x + 12, y + 26);

      timestamps.push(Number(time.toFixed(3)));
      sheetFrame += 1;

      if (sheetFrame === framesPerSheet) await finishSheet();
      report(84 + Math.round(((index + 1) / capturedFrames.length) * 15), { phase: 'encoding' });
    }

    await finishSheet();
    report(100, { phase: 'complete' });

    const effectiveInterval = Math.max(0.75, duration / Math.max(1, capturedFrames.length));
    const totalBytes = sheets.reduce((sum, blob) => sum + blob.size, 0);
    const sceneBoundaries = detectSceneBoundaries(motionProfile, effectiveInterval);
    return {
      sheets,
      timestamps,
      duration,
      interval: effectiveInterval,
      totalBytes,
      motionProfile,
      sceneBoundaries,
      skippedTimestamps,
      performance: {
        ...timings,
        seekMs: Math.round(timings.seekMs),
        maxSeekMs: Math.round(timings.maxSeekMs),
        encodeMs: Math.round(timings.encodeMs),
        totalMs: Math.round(performance.now() - startedAt),
        frames: capturedFrames.length,
        skippedFrames: skippedTimestamps.length
      }
    };
  } finally {
    for (const frame of capturedFrames) {
      frame.snapshot.width = 0;
      frame.snapshot.height = 0;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (ownsObjectUrl) URL.revokeObjectURL(url);
    if (bufferedUrl) URL.revokeObjectURL(bufferedUrl);
  }
}
