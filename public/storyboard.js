export async function extractStoryboard(file, onProgress = () => {}, signal) {
  const url = URL.createObjectURL(file);
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

    // Video uzunluğundan bağımsız, en fazla yaklaşık 228 kare üret.
  // Kısa videolarda daha sık; uzun videolarda daha dengeli örnekleme yapar.
  const interval = Math.max(0.75, duration / 228);
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

    for (let index = 0; index < times.length; index += 1) {
      if (signal?.aborted) throw new DOMException('İşlem iptal edildi', 'AbortError');

      const time = Math.min(times[index], Math.max(0, duration - 0.05));
      if (Math.abs(video.currentTime - time) > 0.01) {
        video.currentTime = time;
        await wait('seeked');
      }

      const column = sheetFrame % columns;
      const row = Math.floor(sheetFrame / columns);
      const x = column * cellWidth;
      const y = row * cellHeight;

      ctx.drawImage(video, x, y, cellWidth, cellHeight);
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(x + 6, y + 6, 92, 28);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`${time.toFixed(1)}s`, x + 12, y + 26);

      timestamps.push(Number(time.toFixed(3)));
      sheetFrame += 1;

      if (sheetFrame === framesPerSheet) await finishSheet();
      onProgress(Math.round(((index + 1) / times.length) * 100));
    }

    await finishSheet();

    const totalBytes = sheets.reduce((sum, blob) => sum + blob.size, 0);
    // Ana karelerin hemen sonrasını karşılaştırarak yerel hareket yoğunluğunu ölç.
    // Böylece hızlanma, yavaşlama ve kısa hareket değişimleri analize eklenebilir.
    const motionCanvas = document.createElement('canvas');
    motionCanvas.width = 64;
    motionCanvas.height = 36;
    const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
    const motionProfile = [];
    let previousPixels = null;

    for (const sampleTime of timestamps) {
      const firstTime = Math.min(sampleTime, Math.max(0, duration - 0.05));
      video.currentTime = firstTime;
      await waitForSeek(video);

      motionCtx.drawImage(video, 0, 0, 64, 36);
      const firstPixels = motionCtx.getImageData(0, 0, 64, 36).data;

      const probeTime = Math.min(sampleTime + 0.3, Math.max(0, duration - 0.05));
      video.currentTime = probeTime;
      await waitForSeek(video);

      motionCtx.drawImage(video, 0, 0, 64, 36);
      const secondPixels = motionCtx.getImageData(0, 0, 64, 36).data;

      let difference = 0;
      for (let i = 0; i < firstPixels.length; i += 16) {
        difference +=
          Math.abs(firstPixels[i] - secondPixels[i]) +
          Math.abs(firstPixels[i + 1] - secondPixels[i + 1]) +
          Math.abs(firstPixels[i + 2] - secondPixels[i + 2]);
      }

      const comparisons = Math.max(1, Math.ceil(firstPixels.length / 16));
      const score = Math.min(100, Math.round(difference / comparisons / 7.65));
      const level = score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';

      motionProfile.push({
        time: Number(sampleTime.toFixed(2)),
        score,
        level
      });

      previousPixels = secondPixels;
    }

    return {
      sheets,
      timestamps,
      duration,
      interval,
      totalBytes,
      motionProfile
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
