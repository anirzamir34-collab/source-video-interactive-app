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

export function sheetsPerAnalysisChunk(qualityMode = 'ultra') {
  const mode = String(qualityMode || 'ultra').toLowerCase();
  if (mode === 'fast') return 4;
  return 3;
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

export async function extractStoryboard(source, onProgress = () => {}, signal) {
  const ownsObjectUrl = source instanceof Blob;
  const url = ownsObjectUrl ? URL.createObjectURL(source) : String(source || '');
  if (!url) throw new Error('Video kaynağı bulunamadı.');
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const wait = (event) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('İşlem iptal edildi', 'AbortError'));
    if (signal?.aborted) return abort();
    video.addEventListener(event, resolve, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
  });

  try {
    await wait('loadedmetadata');

    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Video süresi okunamadı.');
    }

    const samplingPlan = storyboardSamplingPlan(duration, !ownsObjectUrl);
    const targetFrameCount = samplingPlan.baseCount;
    const interval = Math.max(0.75, duration / targetFrameCount);
    const times = [];
    for (let time = 0; time < duration; time += interval) times.push(time);

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
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error('Storyboard oluşturulamadı.')),
          'image/jpeg',
          0.6
        )
      );
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
    const capturedFrames = [];

    const captureFrame = async (time, progress) => {
      if (signal?.aborted) throw new DOMException('İşlem iptal edildi', 'AbortError');

      const safeTime = Math.min(time, Math.max(0, duration - 0.05));
      if (Math.abs(video.currentTime - safeTime) > 0.01) {
        video.currentTime = safeTime;
        await wait('seeked');
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
      onProgress(Math.min(84, Math.max(1, Math.round(progress))));
    };

    for (let index = 0; index < times.length; index += 1) {
      await captureFrame(times[index], ((index + 1) / times.length) * 58);
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
    for (let index = 0; index < focusedTimes.length; index += 1) {
      await captureFrame(
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
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(x + 6, y + 6, 92, 28);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`${time.toFixed(1)}s`, x + 12, y + 26);

      timestamps.push(Number(time.toFixed(3)));
      sheetFrame += 1;

      if (sheetFrame === framesPerSheet) await finishSheet();
      onProgress(84 + Math.round(((index + 1) / capturedFrames.length) * 16));
    }

    await finishSheet();

    const effectiveInterval = Math.max(0.75, duration / Math.max(1, capturedFrames.length));
    const totalBytes = sheets.reduce((sum, blob) => sum + blob.size, 0);
    const sceneBoundaries = detectSceneBoundaries(motionProfile, effectiveInterval);
    for (const frame of capturedFrames) {
      frame.snapshot.width = 0;
      frame.snapshot.height = 0;
    }
    return {
      sheets,
      timestamps,
      duration,
      interval: effectiveInterval,
      totalBytes,
      motionProfile,
      sceneBoundaries
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (ownsObjectUrl) URL.revokeObjectURL(url);
  }
}
