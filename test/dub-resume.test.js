import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDubResume } from '../lib/turkish-media/resume.js';

const base = () => ({
  sourceTranscript: { version: 1, speakers: [{ speakerId: 'speaker-a' }, { speakerId: 'speaker-b' }],
    utterances: [
      { segmentId: 'segment-1', speakerId: 'speaker-a', sourceStart: 1, sourceEnd: 2, sourceText: 'Hi.' },
      { segmentId: 'segment-2', speakerId: 'speaker-b', sourceStart: 3, sourceEnd: 4, sourceText: 'Yes.' }] },
  translatedUtterances: [{ segmentId: 'segment-1', translatedText: 'Selam.' }, { segmentId: 'segment-2', translatedText: 'Evet.' }],
  voiceMapping: { 'speaker-a': 'voice-a', 'speaker-b': 'voice-b' },
  dubSegments: [{ segmentId: 'segment-1', speakerId: 'speaker-a', start: 1, end: 2 }],
  pendingSegmentIds: ['segment-2']
});

test('a saved partial dub resumes with only its missing lines', () => {
  const resume = sanitizeDubResume(base());
  assert.deepEqual(resume.pendingSegmentIds, ['segment-2']);
  assert.equal(resume.dubSegments.length, 1);
  assert.equal(sanitizeDubResume(undefined), null);
});

test('a resume never re-voices a finished line or a line without a voice', () => {
  assert.throws(() => sanitizeDubResume({ ...base(), pendingSegmentIds: ['segment-1'] }), /eksik cümle/);
  assert.throws(() => sanitizeDubResume({ ...base(), pendingSegmentIds: [] }), /eksik cümle yok/);
  assert.throws(() => sanitizeDubResume({ ...base(), voiceMapping: { 'speaker-a': 'voice-a' } }), /sesi/);
  assert.throws(() => sanitizeDubResume({ ...base(), translatedUtterances: base().translatedUtterances.slice(0, 1) }), /çeviri/);
});
