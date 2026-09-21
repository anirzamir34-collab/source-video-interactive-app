// Conservative levels leave headroom when the two tracks are summed.
export const DUB_MIX = Object.freeze({ voice: 0.52, sourceSpeaking: 0.10, sourceIdle: 0.22 });

export function createDubMixer(video, {
  now = () => performance.now(),
  schedule = callback => requestAnimationFrame(callback),
  cancel = handle => cancelAnimationFrame(handle)
} = {}) {
  let original = null;
  let target = null;
  let frame = null;

  function ramp(value, immediate = false) {
    if (target === value && !immediate) return;
    target = value;
    if (frame !== null) cancel(frame);
    frame = null;
    const from = video.volume;
    if (immediate || Math.abs(from - value) < 0.001) {
      video.volume = value;
      return;
    }
    const started = now();
    const duration = value < from ? 80 : 450;
    const step = () => {
      const progress = Math.min(1, Math.max(0, (now() - started) / duration));
      // Smoothstep avoids a click at either end of a level transition.
      const blend = progress * progress * (3 - 2 * progress);
      video.volume = from + (value - from) * blend;
      frame = progress < 1 ? schedule(step) : null;
    };
    frame = schedule(step);
  }

  return {
    update({ enabled, keepOriginal = true, speaking = false }) {
      if (!enabled) {
        if (original) {
          ramp(original.volume, true);
          video.muted = original.muted;
          original = null;
        }
        return;
      }
      const entering = !original;
      original ||= { volume: video.volume, muted: video.muted };
      video.muted = original.muted || !keepOriginal;
      ramp(original.volume * (speaking ? DUB_MIX.sourceSpeaking : DUB_MIX.sourceIdle), entering);
    },
    voiceVolume(count = 1) {
      const voices = Math.max(1, Number(count) || 1);
      // Keep overlapping dialogue intelligible while leaving source headroom.
      return (original?.volume ?? video.volume) * Math.min(DUB_MIX.voice / Math.sqrt(voices), 0.82 / voices);
    }
  };
}

// Fit modest translation-length differences without skipping samples or
// repeatedly seeking the voice. Short sentences keep their natural speed.
export function naturalDubRate(audioDuration, sourceDuration, videoRate = 1) {
  const duration = Math.max(0.05, Number(sourceDuration) || 0.05);
  const speechRate = Math.min(1.3, Math.max(1, (Number(audioDuration) || duration) / duration));
  return speechRate * Math.min(4, Math.max(0.25, Number(videoRate) || 1));
}

export function canFinishDubTail(audio, nextSegment, videoTime) {
  // Timestamp boundaries are estimates. Let a short final word finish before
  // starting the next speaker, but never accumulate an unbounded speech queue.
  const remaining = (Number(audio.duration) - Number(audio.currentTime)) / Math.max(0.25, audio.playbackRate || 1);
  const boundary = Number(nextSegment?.startTime ?? audio._vqSegment?.endTime);
  return Number.isFinite(remaining) && remaining >= 0 && remaining <= 0.55 &&
    (!Number.isFinite(boundary) || Number(videoTime) - boundary <= 0.55);
}

// Follow the rate actually used by this utterance, not a different linear
// duration fit. Never seek backwards during continuous playback: that repeats
// words. A voice ahead of the video waits; a stalled voice resynchronizes.
export function correctDubClock(audio, videoTime, videoRate = 1) {
  const rate = Number(audio._vqSpeechRate) || 1;
  const anchor = Number(audio._vqAnchorVideoTime);
  if (!Number.isFinite(anchor) || !Number.isFinite(Number(audio.duration))) return;
  const target = Math.max(0, Math.min(audio.duration,
    (Number(audio._vqAnchorAudioTime) || 0) + Math.max(0, videoTime - anchor) * rate));
  const drift = Number(audio.currentTime) - target;
  if (drift > 0.4) {
    audio._vqClockHold = true;
    audio.pause();
  } else if (audio._vqClockHold && drift <= 0.08) audio._vqClockHold = false;
  if (drift < -0.4) audio.currentTime = target;
  const correction = Math.abs(drift) >= 0.12 && Math.abs(drift) <= 0.4
    ? Math.min(0.08, Math.max(-0.08, -drift * 0.25)) : 0;
  audio.playbackRate = Math.max(0.25, Math.min(4, (rate + correction) * videoRate));
}
