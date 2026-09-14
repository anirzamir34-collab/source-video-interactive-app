const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function isCompleteChunkAnalysis({ completedChunkCount = 0, expectedChunkCount = 0, failed = false } = {}) {
  const completed = Math.max(0, Math.floor(Number(completedChunkCount) || 0));
  const expected = Math.max(0, Math.floor(Number(expectedChunkCount) || 0));
  return !failed && expected > 0 && completed === expected;
}

export function dialogueSegmentAt(segments, videoTime, tolerance = 0.04) {
  const time = Math.max(0, Number(videoTime) || 0);
  const pad = Math.max(0, Number(tolerance) || 0);
  const list = Array.isArray(segments) ? segments : [];

  const active = list.filter(segment => {
    const start = Number(segment?.startTime);
    const end = Number(segment?.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start &&
      time >= start - pad && time < end + pad;
  });

  // When timestamp estimates overlap, the newest utterance owns the screen.
  // This switches the caption immediately instead of keeping the previous
  // speaker visible until their estimated end time.
  return active.sort((left, right) =>
    Number(right.startTime) - Number(left.startTime)
  )[0] || null;
}

export function decisionBoundaryAfterDialogue(
  segments,
  actionEndTime,
  videoDuration = Number.POSITIVE_INFINITY,
  tolerance = 0.04
) {
  const actionEnd = Math.max(0, Number(actionEndTime) || 0);
  const duration = Number.isFinite(Number(videoDuration))
    ? Math.max(actionEnd, Number(videoDuration))
    : Number.POSITIVE_INFINITY;
  const pad = Math.max(0, Number(tolerance) || 0);
  const activeEnds = (Array.isArray(segments) ? segments : [])
    .filter(segment => {
      const start = Number(segment?.startTime);
      const end = Number(segment?.endTime);
      return Number.isFinite(start) && Number.isFinite(end) && end > start &&
        start <= actionEnd + pad && end > actionEnd + pad;
    })
    .map(segment => Number(segment.endTime));

  return Math.min(duration, Math.max(actionEnd, ...activeEnds));
}

export function dubSegmentKey(segment, fallbackIndex = 0) {
  if (!segment) return '';
  const stableId = String(segment.segmentId || '').trim();
  if (stableId) return stableId;

  const start = Number(segment.startTime) || 0;
  const end = Number(segment.endTime) || start;
  const speaker = String(segment.speakerId || segment.gender || 'speaker');
  const text = String(segment.turkishText || '').trim().slice(0, 48);
  return `dub-${fallbackIndex}-${start.toFixed(3)}-${end.toFixed(3)}-${speaker}-${text}`;
}

export function mapVideoTimeToDubTime({ videoTime = 0, segmentStart = 0, segmentEnd = 0, audioDuration = 0 } = {}) {
  const start = Number(segmentStart) || 0;
  const end = Math.max(start, Number(segmentEnd) || start);
  const duration = Math.max(0, Number(audioDuration) || 0);
  if (!duration || end <= start) return 0;

  const fraction = clamp((Number(videoTime) - start) / (end - start), 0, 1);
  return clamp(fraction * duration, 0, Math.max(0, duration - 0.02));
}

export function fittedDubPlaybackRate({ audioDuration = 0, segmentDuration = 0, videoPlaybackRate = 1 } = {}) {
  const audio = Math.max(0, Number(audioDuration) || 0);
  const segment = Math.max(0.05, Number(segmentDuration) || 0.05);
  const videoRate = clamp(videoPlaybackRate, 0.25, 4);
  if (!audio) return videoRate;
  return clamp((audio / segment) * videoRate, 0.8, 1.35);
}

export function dubMasterClockCorrection({
  videoTime = 0,
  audioTime = 0,
  segmentStart = 0,
  segmentEnd = 0,
  audioDuration = 0,
  videoPlaybackRate = 1,
  softDrift = 0.15,
  hardDrift = 0.4
} = {}) {
  const targetTime = mapVideoTimeToDubTime({
    videoTime,
    segmentStart,
    segmentEnd,
    audioDuration
  });
  const baseRate = fittedDubPlaybackRate({
    audioDuration,
    segmentDuration: Math.max(0.05, Number(segmentEnd) - Number(segmentStart)),
    videoPlaybackRate
  });
  const drift = (Number(audioTime) || 0) - targetTime;
  const magnitude = Math.abs(drift);

  if (magnitude >= Math.max(softDrift, hardDrift)) {
    return { mode: 'seek', targetTime, playbackRate: baseRate, drift };
  }
  if (magnitude >= Math.max(0.01, softDrift)) {
    const correction = clamp(-drift * 0.55, -0.12, 0.12);
    return {
      mode: 'rate',
      targetTime,
      playbackRate: clamp(baseRate + correction, 0.8, 1.35),
      drift
    };
  }
  return { mode: 'hold', targetTime, playbackRate: baseRate, drift };
}

export function nextDialogueSegments(segments, videoTime, count = 2) {
  const list = Array.isArray(segments) ? segments : [];
  const time = Math.max(0, Number(videoTime) || 0);
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  return list
    .filter(segment => Number(segment?.endTime) >= time - 0.04 && String(segment?.turkishText || '').trim())
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))
    .slice(0, wanted);
}
