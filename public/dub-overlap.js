import { dialogueSegmentsAt } from './playback-logic.js';
import { dubSpeakerKey } from './dub-speakers.js';

export function activeDubSegments(segments, time, tolerance = 0) {
  // A timestamp estimation overlap within one speaker is not two voices.
  const active = new Map();
  for (const segment of dialogueSegmentsAt(segments, time, tolerance)) active.set(dubSpeakerKey(segment), segment);
  return [...active.values()];
}

export function sourceSpeechOverlaps(left, right) {
  return Math.min(Number(left?.endTime), Number(right?.endTime)) -
    Math.max(Number(left?.startTime), Number(right?.startTime)) > 0.04;
}

export function dubSpeechEnd(segment, timeline) {
  const next = timeline.filter(row => dubSpeakerKey(row) === dubSpeakerKey(segment) && Number(row.startTime) > Number(segment.startTime))
    .map(row => Number(row.startTime));
  return Math.min(Number(segment.endTime), ...next);
}
