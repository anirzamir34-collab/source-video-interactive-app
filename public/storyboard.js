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
  const targetFrameCount =
    duration <= 300 ? 144 :
    duration <= 900 ? 192 :
    228;

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
    const motionProfile = [];
    let previousMotionPixels = null;

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

      motionCtx.drawImage(video, 0, 0, 64, 36);
      const currentMotionPixels =
        motionCtx.getImageData(0, 0, 64, 36).data;

      let score = 0;

      if (previousMotionPixels) {
        let difference = 0;
        let comparisons = 0;

        for (let pixel = 0; pixel < currentMotionPixels.length; pixel += 16) {
          difference +=
            Math.abs(currentMotionPixels[pixel] - previousMotionPixels[pixel]) +
            Math.abs(currentMotionPixels[pixel + 1] - previousMotionPixels[pixel + 1]) +
            Math.abs(currentMotionPixels[pixel + 2] - previousMotionPixels[pixel + 2]);
          comparisons += 1;
        }

        score = Math.min(
          100,
          Math.round(difference / Math.max(1, comparisons) / 7.65)
        );
      }

      motionProfile.push({
        time: Number(time.toFixed(2)),
        score,
        level: score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low'
      });

      previousMotionPixels = new Uint8ClampedArray(currentMotionPixels);
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
