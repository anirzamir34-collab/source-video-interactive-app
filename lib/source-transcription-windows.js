import { requireDialogueTiming } from '../public/dialogue-integrity.js';

const seconds = value => Math.round(value * 1000) / 1000;
const textKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase('tr-TR')
  .replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/gu, ' ').trim();

export function planSourceTranscriptionWindows(duration, {
  windowSeconds = 90, overlapSeconds = 6, singleWindowSeconds = 120
} = {}) {
  const limit = Number(duration);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('SOURCE_AUDIO_DURATION_REQUIRED');
  if (!Number.isFinite(windowSeconds) || windowSeconds < 60 || windowSeconds > 120 ||
      !Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds >= windowSeconds ||
      !Number.isFinite(singleWindowSeconds) || singleWindowSeconds > 120 || singleWindowSeconds < windowSeconds) {
    throw new Error('INVALID_SOURCE_TRANSCRIPTION_WINDOW_PLAN');
  }
  if (limit <= singleWindowSeconds) return [{ id: 'window-001', index: 0, startTime: 0, endTime: seconds(limit) }];
  const windows = [];
  for (let start = 0; start < limit; start += windowSeconds - overlapSeconds) {
    const end = Math.min(limit, start + windowSeconds);
    windows.push({ id: `window-${String(windows.length + 1).padStart(3, '0')}`,
      index: windows.length, startTime: seconds(start), endTime: seconds(end) });
    if (end >= limit) break;
  }
  return windows;
}

// Timestamps returned by a window provider are always relative to that actual
// asset. Validate before adding the offset; never clamp an out-of-range answer.
export function groundWindowResult(result, window) {
  if (!Array.isArray(result?.segments)) throw new SyntaxError('SOURCE_WINDOW_SEGMENTS_REQUIRED');
  const span = window.endTime - window.startTime;
  requireDialogueTiming(result.segments, span);
  let rejectedInvalidEventCount = 0;
  const timed = (rows, kind) => {
    const output = [];
    for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
      const start = Number(row.startTime), end = Number(row.endTime);
      const valid = Number.isFinite(start) && Number.isFinite(end) &&
        start >= 0 && end > start && end <= span + 0.05;
      if (!valid) {
        // Non-speech annotations are supplemental metadata. A provider can
        // occasionally place one outside the bounded window; never let that
        // discard otherwise verified dialogue from the same source audio.
        if (kind === 'event') {
          rejectedInvalidEventCount++;
          continue;
        }
        throw Object.assign(new Error('SOURCE_WINDOW_TIMESTAMP_INVALID'), { code: 'DIALOGUE_TIMING_INVALID' });
      }
      output.push({ ...row, timestampUnit: 'seconds',
        [kind === 'speech' ? 'segmentId' : 'eventId']: `${window.id}:${row[kind === 'speech' ? 'segmentId' : 'eventId'] || index + 1}`,
        startTime: seconds(window.startTime + start), endTime: seconds(window.startTime + end),
        sourceWindowId: window.id });
    }
    return output;
  };
  const segments = timed(result.segments, 'speech');
  const nonSpeechEvents = timed(result.nonSpeechEvents, 'event');
  const warnings = [
    ...(Array.isArray(result.warnings) ? result.warnings : []),
    ...(rejectedInvalidEventCount
      ? [`Rejected ${rejectedInvalidEventCount} non-speech event(s) outside source-window timing.`]
      : [])
  ];
  return { ...result, timestampUnit: 'seconds', segments, nonSpeechEvents, warnings,
    rejectedInvalidSegmentCount: Math.max(0, Number(result.rejectedInvalidSegmentCount) || 0),
    rejectedInvalidEventCount };
}

const sameObservation = (left, right) => {
  if (!textKey(left.originalText) || textKey(left.originalText) !== textKey(right.originalText)) return false;
  const overlap = Math.max(0, Math.min(left.endTime, right.endTime) - Math.max(left.startTime, right.startTime));
  const shortest = Math.min(left.endTime - left.startTime, right.endTime - right.startTime);
  return overlap / Math.max(0.05, shortest) >= 0.7 ||
    (Math.abs(left.startTime - right.startTime) <= 0.35 && Math.abs(left.endTime - right.endTime) <= 0.35);
};

export function mergeGroundedSourceWindows(windows) {
  const segments = [], nonSpeechEvents = [], speakers = new Map();
  let deduplicatedOverlapCount = 0;
  const warnings = new Set();
  const languages = new Set();
  const engines = new Set();
  for (const window of windows) {
    if (window.status !== 'complete' || !window.result) continue;
    const result = window.result;
    const identities = new Map();
    const ambiguousIdentities = new Set();
    // Diarization IDs are local to each recording. Reuse a voice identity only
    // when a unique repeated audible observation exists inside the overlap.
    for (const row of result.segments) {
      const local = String(row.speakerId || 'speaker-unknown');
      const matches = segments.filter(previous => previous.sourceWindowId !== window.id &&
        previous.endTime > window.startTime && previous.startTime < window.endTime && sameObservation(previous, row));
      const ids = new Set(matches.map(previous => previous.speakerId));
      if (ids.size === 1) {
        const id = [...ids][0];
        if (identities.has(local) && identities.get(local) !== id) ambiguousIdentities.add(local);
        if (!ambiguousIdentities.has(local)) identities.set(local, id);
      } else if (ids.size > 1) {
        ambiguousIdentities.add(local);
      }
    }
    const voiceId = value => {
      const local = String(value || 'speaker-unknown');
      return (!ambiguousIdentities.has(local) && identities.get(local)) || `${window.id}:${local}`;
    };
    for (const profile of Array.isArray(result.speakers) ? result.speakers : []) {
      const speakerId = voiceId(profile.speakerId);
      if (!speakers.has(speakerId)) speakers.set(speakerId, { ...profile, speakerId, speakerName: '' });
    }
    for (const original of result.segments) {
      const row = { ...original, speakerId: voiceId(original.speakerId), speakerName: '' };
      const duplicate = segments.find(previous => previous.sourceWindowId !== window.id &&
        previous.speakerId === row.speakerId && sameObservation(previous, row));
      if (duplicate) { deduplicatedOverlapCount++; continue; }
      segments.push(row);
    }
    for (const event of result.nonSpeechEvents || []) {
      const row = { ...event, speakerId: voiceId(event.speakerId) };
      const duplicate = nonSpeechEvents.some(previous => previous.sourceWindowId !== window.id &&
        previous.speakerId === row.speakerId && previous.soundType === row.soundType &&
        Math.abs(previous.startTime - row.startTime) <= 0.35 && Math.abs(previous.endTime - row.endTime) <= 0.35);
      if (!duplicate) nonSpeechEvents.push(row);
    }
    (Array.isArray(result.warnings) ? result.warnings : []).forEach(value => warnings.add(String(value)));
    if (result.sourceLanguage && result.sourceLanguage !== 'unknown') languages.add(result.sourceLanguage);
    if (result.transcriptionEngine) engines.add(result.transcriptionEngine);
  }
  segments.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  nonSpeechEvents.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  return { available: true, hasDialogue: segments.length > 0, timestampUnit: 'seconds', segments,
    speakers: [...speakers.values()], nonSpeechEvents, warnings: [...warnings],
    sourceLanguage: languages.size > 1 ? 'multilingual' : [...languages][0] || 'unknown',
    transcriptionEngine: [...engines].join('+'),
    summaryTr: '', deduplicatedOverlapCount };
}

function gapsBetweenIntervals(intervals, duration) {
  const gaps = [];
  let cursor = 0;
  for (const interval of [...intervals].sort((a, b) => a.startTime - b.startTime)) {
    if (interval.startTime > cursor + 0.05) gaps.push({ startTime: seconds(cursor), endTime: seconds(interval.startTime) });
    cursor = Math.max(cursor, interval.endTime);
  }
  if (cursor < duration - 0.05) gaps.push({ startTime: seconds(cursor), endTime: seconds(duration) });
  return gaps;
}

export function auditSourceTranscript(state, segments = []) {
  const windows = state.windows || [];
  const completed = windows.filter(window => window.status === 'complete');
  const failed = windows.filter(window => window.status === 'failed');
  const first = segments.length ? Math.min(...segments.map(row => row.startTime)) : null;
  const last = segments.length ? Math.max(...segments.map(row => row.endTime)) : null;
  // A minority of provider-window failures should not discard every verified
  // transcript row. Abort only when failed coverage outweighs completed
  // coverage, or no source window succeeded at all.
  const fatalCoverage = windows.length > 0 &&
    (completed.length === 0 || failed.length > completed.length || (segments.length === 0 && failed.length > 0));
  const rejectedInvalidSegments = completed.reduce((sum, window) =>
    sum + Math.max(0, Number(window.result?.rejectedInvalidSegmentCount) || 0), 0);
  const rejectedInvalidEvents = completed.reduce((sum, window) =>
    sum + Math.max(0, Number(window.result?.rejectedInvalidEventCount) || 0), 0);
  return { schemaVersion: 2, sourceDuration: state.duration, videoDuration: state.videoDuration || state.duration,
    windowCount: windows.length, totalWindows: windows.length,
    processedWindowCount: completed.length, completeWindows: completed.length,
    failedWindows: failed.map(window => ({
      id: window.id, startTime: window.startTime, endTime: window.endTime, reason: window.errorCode || 'SOURCE_WINDOW_FAILED'
    })),
    failedWindowCount: failed.length,
    retriedWindows: windows.filter(window => Number(window.attempts) > 1).length,
    retainedSuccessfulWindows: Math.max(0, Number(state.retainedSuccessfulWindowCount) || 0),
    rejectedInvalidSegments,
    rejectedInvalidEvents,
    unprocessedWindows: gapsBetweenIntervals(completed, state.videoDuration || state.duration),
    uncoveredWindows: gapsBetweenIntervals(segments, state.videoDuration || state.duration),
    firstTranscriptTime: first, lastTranscriptTime: last, transcriptSpan: first == null ? 0 : seconds(last - first),
    segmentCount: segments.length, complete: completed.length === windows.length,
    fatalCoverage,
    usable: !fatalCoverage,
    uncoveredWindowMeaning: 'no-detected-transcript; not evidence of speech or silence',
    windows: windows.map(window => ({ id: window.id, startTime: window.startTime, endTime: window.endTime,
      status: window.status, attempts: window.attempts || 0, segmentCount: window.result?.segments?.length || 0,
      rejectedInvalidSegmentCount: Number(window.result?.rejectedInvalidSegmentCount) || 0 })) };
}

// The caller owns this retained session object. Assets and successful results
// survive a failed request, so retries prepare/transcribe only failed windows.
// Sequential processing bounds ffmpeg, uploads, inline audio and provider RAM.
function systemicProviderFailure(error) {
  const status = Number(error?.status || error?.code);
  const details = String(error?.message || error || '').toLowerCase();
  return [401, 403, 429].includes(status) ||
    /resource_exhausted|quota|rate limit|rate_limit|api[_ ]?key.*(?:invalid|expired)|permission_denied/.test(details);
}

export async function transcribeSourceWindows({ duration, videoDuration = duration, state = {},
  prepareAsset, transcribeWindow, releaseAsset, signal, onProgress = () => {}, speechEvidence = [], recheckWindow,
  planOptions, recoveryPass = 0
}) {
  const plan = planSourceTranscriptionWindows(duration, planOptions);
  const signature = JSON.stringify(plan);
  if (state.planSignature && state.planSignature !== signature) throw new Error('SOURCE_WINDOW_PLAN_CHANGED');
  state.planSignature = signature;
  state.duration = Number(duration);
  state.videoDuration = Math.max(Number(videoDuration) || state.duration, state.duration);
  state.windows ||= plan.map(window => ({ ...window, status: 'pending', attempts: 0 }));
  state.retainedSuccessfulWindowCount = state.windows.filter(window => window.status === 'complete').length;
  for (const window of state.windows) {
    signal?.throwIfAborted();
    if (window.status === 'complete') continue;
    window.attempts++;
    window.status = 'processing';
    onProgress({ windowId: window.id, index: window.index, windowCount: plan.length,
      stage: window.attempts > 1 ? 'retry' : 'start' });
    try {
      window.asset ||= await prepareAsset(window);
      signal?.throwIfAborted();
      const result = await transcribeWindow(window.asset, window);
      signal?.throwIfAborted();
      window.result = groundWindowResult(result, window);
      // A transcript gap alone never triggers speculative speech generation.
      // Only explicit source speech evidence may justify a listening recheck.
      const evidence = speechEvidence.filter(item => Number(item.endTime) > window.startTime &&
        Number(item.startTime) < window.endTime && item.type === 'speech' && item.sourceVerified === true);
      if (recheckWindow && evidence.some(item => !window.result.segments.some(row =>
        row.endTime > item.startTime && row.startTime < item.endTime))) {
        const checked = await recheckWindow(window.asset, window, evidence);
        window.result = groundWindowResult(checked, window);
        window.evidenceRechecked = true;
      }
      window.status = 'complete';
      delete window.errorCode;
      if (releaseAsset) {
        try { await releaseAsset(window.asset, window); } catch {}
        delete window.asset;
      } else if (window.asset?.inlineAudioPart) {
        delete window.asset.inlineAudioPart;
      }
    } catch (error) {
      window.status = 'failed';
      window.errorCode = String(error?.code || (error instanceof SyntaxError ? 'SOURCE_WINDOW_JSON_INVALID' : 'SOURCE_WINDOW_FAILED'));
      window.errorMessage = String(error?.message || error || '').slice(0, 500);
      if (error?.code === 'SOURCE_WINDOW_ASSET_EXPIRED') delete window.asset;
      onProgress({ windowId: window.id, index: window.index, windowCount: plan.length, stage: window.status });
      if (signal?.aborted) throw error;
      // Auth/quota failures affect every remaining window. Retrying all 11
      // windows only hides the real provider error behind SOURCE_TRANSCRIPTION_INCOMPLETE.
      if (systemicProviderFailure(error)) throw error;
      continue;
    }
    onProgress({ windowId: window.id, index: window.index, windowCount: plan.length, stage: window.status });
  }
  const parsed = mergeGroundedSourceWindows(state.windows);
  requireDialogueTiming(parsed.segments, state.duration);
  let coverageAudit = auditSourceTranscript(state, parsed.segments);

  // If all verified speech disappeared only because some windows failed, give
  // those retained failed windows one fresh pass. Completed windows are skipped
  // and their extracted/uploaded results are preserved.
  if (!parsed.segments.length && coverageAudit.failedWindowCount > 0 && recoveryPass < 1) {
    onProgress({ stage: 'zero-speech-recovery', windowCount: plan.length });
    return transcribeSourceWindows({
      duration, videoDuration, state, prepareAsset, transcribeWindow, releaseAsset,
      signal, onProgress, speechEvidence, recheckWindow, planOptions, recoveryPass: recoveryPass + 1
    });
  }

  coverageAudit = auditSourceTranscript(state, parsed.segments);
  if (!coverageAudit.complete) {
    parsed.warnings = [...new Set([
      ...(parsed.warnings || []),
      `Source transcription partial: ${coverageAudit.completeWindows}/${coverageAudit.totalWindows} windows completed.`
    ])];
  }
  if (coverageAudit.fatalCoverage) throw Object.assign(new Error('SOURCE_TRANSCRIPTION_INCOMPLETE'), {
    code: 'SOURCE_TRANSCRIPTION_INCOMPLETE', coverageAudit, partialResult: parsed
  });
  return { parsed, coverageAudit };
}
