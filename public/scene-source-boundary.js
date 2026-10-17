// Gameplay surface lifetime is bounded by the actual source-video chapter.
// An active replay selection cannot keep an old encounter panel on screen
// after ordinary playback or a seek reaches an unrelated source interval.
export function sourceOutsideScene(scene, time, tolerance = 0.2) {
  if (!scene) return false;
  const start = Number(scene.startTime), end = Number(scene.endTime), at = Number(time);
  if (![start, end, at].every(Number.isFinite) || end <= start) return false;
  const margin = Math.max(0, Number(tolerance) || 0);
  return at < start - margin || at > end + margin;
}
