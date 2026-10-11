// Authoritative completion accounting for one source-verified gameplay clip.
// A successful HTMLMediaElement.play() call means playback started, not that the
// source interval was played. Progress/combo credit is awarded only after a
// verified clip's end is reached with observed real playback coverage.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const intervalOf = pending => {
  const clip = pending?.kind === 'prelude' ? pending.item : pending?.movement;
  if (!clip || clip.sourceVerified !== true) return null;
  const startTime = finite(clip.loopStartTime ?? clip.startTime);
  const endTime = finite(clip.loopEndTime ?? clip.endTime);
  return startTime !== null && endTime !== null && endTime > startTime
    ? { startTime, endTime } : null;
};

export function beginVerifiedClipPlayback(pending, token) {
  if (!pending || pending.token !== token || !intervalOf(pending)) return pending;
  return { ...pending, playStarted: true, observedSeconds: Number(pending.observedSeconds) || 0 };
}

export function observeVerifiedClipPlayback(pending, { startTime, endTime, playing = false, seek = false } = {}) {
  const clip = intervalOf(pending);
  const start = finite(startTime), end = finite(endTime);
  if (!clip || pending?.playStarted !== true || !playing || seek ||
      start === null || end === null || end <= start) return pending;
  const seconds = Math.max(0, Math.min(end, clip.endTime) - Math.max(start, clip.startTime));
  return { ...pending, observedSeconds: Math.min(clip.endTime - clip.startTime,
    Math.max(0, Number(pending.observedSeconds) || 0) + seconds) };
}

export function verifiedClipCompletionReady(pending, { token, mediaTime } = {}) {
  const clip = intervalOf(pending);
  if (!clip || pending.token !== token || pending.playStarted !== true) return false;
  const now = finite(mediaTime);
  if (now === null || now < clip.endTime - 0.04) return false;
  // Require meaningful source playback instead of crediting a seek to the end.
  // Very short clips still need a majority of their verified frames observed.
  const minimumPlayback = (clip.endTime - clip.startTime) * 0.65;
  return Number(pending.observedSeconds) >= minimumPlayback - 0.05;
}
