import { normalizeDialogueSegments } from './dialogue-integrity.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

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

export function seekMediaTo(video, requestedTime, { signal, timeoutMs = 8000 } = {}) {
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

export function dialogueSegmentsAt(segments, videoTime, tolerance = 0.04) {
  const time = Math.max(0, Number(videoTime) || 0);
  const pad = Math.max(0, Number(tolerance) || 0);
  return (Array.isArray(segments) ? segments : [])
    .filter(segment => {
      const start = Number(segment?.startTime);
      const end = Number(segment?.endTime);
      return Number.isFinite(start) && Number.isFinite(end) && end > start &&
        time >= start - pad && time < end + pad &&
        String(segment?.turkishText || '').trim();
    })
    .sort((left, right) =>
      Number(left.startTime) - Number(right.startTime) ||
      String(left.speakerId || '').localeCompare(String(right.speakerId || ''))
    );
}

export function resolveDubGender(segmentGender, profileGender, rememberedGender = 'uncertain') {
  const normalize = value => {
    const gender = String(value || '').trim().toLowerCase();
    return gender === 'male' || gender === 'female' ? gender : 'uncertain';
  };
  const line = normalize(segmentGender);
  if (line !== 'uncertain') return line;
  const remembered = normalize(rememberedGender);
  if (remembered !== 'uncertain') return remembered;
  return normalize(profileGender);
}

export function isDubStartTimely(videoTime, segment = {}, maxDelaySeconds = 0.65) {
  const now = Number(videoTime);
  const start = Number(segment?.startTime);
  const end = Number(segment?.endTime);
  if (![now, start, end].every(Number.isFinite) || end <= start) return false;
  const latest = Math.min(end, start + Math.max(0.1, Number(maxDelaySeconds) || 0.65));
  return now >= start - 0.12 && now <= latest;
}

export function buildDubBlocks(segments, { mergeAdjacent = false, maxGap = 0.28, maxDuration = 14 } = {}) {
  const rows = normalizeDialogueSegments(segments)
    .filter(segment => String(segment?.turkishText || '').trim())
    .map(segment => ({ ...segment }))
    .sort((left, right) => Number(left.startTime) - Number(right.startTime));
  const blocks = [];

  for (const row of rows) {
    const start = Number(row.startTime);
    const end = Number(row.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const previous = blocks[blocks.length - 1];
    const sameSpeaker = previous && String(previous.speakerId || '') === String(row.speakerId || '');
    const gap = previous ? start - Number(previous.endTime) : Number.POSITIVE_INFINITY;
    const combinedDuration = previous ? end - Number(previous.startTime) : end - start;

    // Merge fragments of an unfinished sentence, not completed replies. TTS
    // has no internal timestamps, so joining "Evet. Evet." destroys the real
    // pauses and can push short replies past the restrained-synthesis cutoff.
    const sentenceEnded = previous && [previous.turkishText, previous.originalText]
      .some(text => /[.!?…]["'”’»\)\]]*$/u.test(String(text || '').trim()));
    const replyKey = text => String(text || '').trim().toLocaleLowerCase('tr-TR');
    const repeatedReply = previous && String(row.turkishText).trim().split(/\s+/u).length <= 4 &&
      replyKey(previous.turkishText) === replyKey(row.turkishText);
    const compatibleGender = !previous?.gender || !row.gender || previous.gender === row.gender;
    if (mergeAdjacent && sameSpeaker && compatibleGender && !sentenceEnded && !repeatedReply &&
        gap >= -0.04 && gap <= maxGap && combinedDuration <= maxDuration) {
      previous.endTime = end;
      previous.turkishText = `${previous.turkishText} ${String(row.turkishText).trim()}`.trim();
      previous.originalText = `${previous.originalText || ''} ${String(row.originalText || '').trim()}`.trim();
      previous.sourceSegmentIds.push(String(row.segmentId || ''));
      previous.segmentId = `dub-block:${previous.sourceSegmentIds.filter(Boolean).join('+')}`;
      continue;
    }

    blocks.push({
      ...row,
      segmentId: `dub-block:${String(row.segmentId || blocks.length + 1)}`,
      sourceSegmentIds: [String(row.segmentId || '')]
    });
  }
  return blocks;
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

export function languageTimelineTime(videoTime, offsetSeconds = 0) {
  const time = Number(videoTime);
  const offset = Number(offsetSeconds);
  return Math.max(0, (Number.isFinite(time) ? time : 0) +
    (Number.isFinite(offset) ? Math.max(-10, Math.min(10, offset)) : 0));
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

export function dialogueSegmentsForTarget(segments, targetTime, count = 2) {
  const list = Array.isArray(segments) ? segments : [];
  const wanted = Math.max(1, Math.floor(Number(count) || 1));
  const active = dialogueSegmentAt(list, targetTime);
  const upcoming = nextDialogueSegments(list, targetTime, wanted);
  const result = [];
  const seen = new Set();

  [active, ...upcoming].filter(Boolean).forEach((segment, index) => {
    const key = dubSegmentKey(segment, index);
    if (!key || seen.has(key) || result.length >= wanted) return;
    seen.add(key);
    result.push(segment);
  });

  return result;
}

export function dialogueSegmentsForTargets(segments, targetTimes, limit = 12) {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  const result = [];
  const seen = new Set();

  (Array.isArray(targetTimes) ? targetTimes : []).forEach(targetTime => {
    dialogueSegmentsForTarget(segments, targetTime, 1).forEach((segment, index) => {
      const key = dubSegmentKey(segment, index);
      if (!key || seen.has(key) || result.length >= wanted) return;
      seen.add(key);
      result.push(segment);
    });
  });

  return result;
}
