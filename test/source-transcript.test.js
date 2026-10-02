import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceContextAdapter, sourceSpeechOverlaps } from '../public/source-transcript.js';

function sourceTranscript() {
  return {
    version: 1,
    source: { hash: 'verified-source-hash', duration: 30 },
    language: 'en',
    speakers: [{ speakerId: 'source-speaker-1', providerId: 'provider-speaker-1', gender: 'male', emotion: 'calm' }],
    utterances: [{ segmentId: 'source-segment-1', speakerId: 'source-speaker-1',
      sourceText: 'The original source speech.', sourceStart: 10.25, sourceEnd: 12.75,
      gender: 'male', confidence: 0.87, emotion: 'calm' }],
    audioEvents: [{ eventId: 'source-event-1', type: 'audio_event', text: 'door closes',
      start: 3.25, end: 3.75, speakerId: null }]
  };
}

test('canonical source utterances preserve original text, identity, and source video timecodes', () => {
  const original = sourceTranscript();
  const before = structuredClone(original);
  const context = sourceContextAdapter(original);
  assert.equal(context.sourceLanguage, 'en');
  assert.equal(context.timestampUnit, 'seconds');
  assert.deepEqual(context.segments, [{ segmentId: 'source-segment-1', speakerId: 'source-speaker-1',
    originalText: 'The original source speech.', text: 'The original source speech.', textTr: '', turkishText: '',
    startTime: 10.25, endTime: 12.75, gender: 'male', speakerName: '', confidence: 0.87, emotion: 'calm' }]);
  assert.equal(context.speakers[0].speakerId, 'source-speaker-1');
  assert.equal(context.speakers[0].speakerName, '');
  assert.deepEqual(original, before, 'the adapter does not mutate original evidence');
});

test('translated dialogue, dub timelines, and invented speaker labels never supply gameplay evidence', () => {
  const source = sourceTranscript();
  Object.assign(source.utterances[0], { text: 'fabricated action', originalText: 'rewritten source',
    textTr: 'invented Turkish action', turkishText: 'invented Turkish action', translatedText: 'invented translation',
    dubText: 'invented dub dialogue', dubStart: 90, dubEnd: 92, startTime: 200, endTime: 250,
    displaySubtitleText: 'invented caption', speakerName: 'invented character', dubGender: 'female' });
  const translations = [{ segmentId: 'source-segment-1', speakerId: 'source-speaker-1',
    translatedText: 'outside translated input', sourceStart: 90, sourceEnd: 92 }];
  const context = sourceContextAdapter(source, translations);
  const row = context.segments[0];
  assert.equal(row.text, 'The original source speech.');
  assert.equal(row.originalText, 'The original source speech.');
  assert.equal(row.startTime, 10.25);
  assert.equal(row.endTime, 12.75);
  assert.equal(row.gender, 'male');
  assert.equal(row.speakerName, '');
  assert.equal(row.textTr, '');
  assert.equal(row.turkishText, '');
  assert.doesNotMatch(JSON.stringify(context), /fabricated|rewritten|invented|outside translated/);
});

test('speaker and sound-event metadata cannot smuggle translated or generated text into source context', () => {
  const source = sourceTranscript();
  Object.assign(source.speakers[0], { speakerName: 'invented character', turkishText: 'injected speaker translation',
    translatedText: 'injected speaker caption', dubText: 'injected speaker dub', dubGender: 'female' });
  Object.assign(source.audioEvents[0], { startTime: 200, endTime: 300, evidence: 'injected event evidence',
    translatedText: 'injected event translation', dubText: 'injected event dub', turkishText: 'injected event Turkish' });
  const context = sourceContextAdapter(source);
  assert.equal(context.speakers[0].gender, 'male');
  assert.equal(context.speakers[0].speakerName, '');
  assert.equal(context.nonSpeechEvents[0].startTime, 3.25);
  assert.equal(context.nonSpeechEvents[0].endTime, 3.75);
  assert.equal(context.nonSpeechEvents[0].evidence, 'door closes');
  assert.doesNotMatch(JSON.stringify(context), /injected|invented/);
  assert.equal(Object.hasOwn(context.speakers[0], 'dubGender'), false);
});

test('unknown source gender and emotion remain uncertain without guessing from names or dub voices', () => {
  for (const gender of [undefined, null, '', 'unknown', 'Male', 'nonbinary']) {
    const source = sourceTranscript();
    source.utterances[0].gender = gender;
    source.utterances[0].emotion = null;
    source.speakers[0].gender = gender;
    source.speakers[0].speakerName = 'Erkek';
    source.speakers[0].dubGender = 'male';
    const context = sourceContextAdapter(source);
    assert.equal(context.segments[0].gender, 'uncertain');
    assert.equal(context.segments[0].emotion, 'uncertain');
    assert.equal(context.speakers[0].gender, 'uncertain');
    assert.equal(context.speakers[0].speakerName, '');
  }
  const femaleSource = sourceTranscript();
  femaleSource.utterances[0].gender = 'female';
  femaleSource.speakers[0].gender = 'female';
  assert.equal(sourceContextAdapter(femaleSource).segments[0].gender, 'female');
  assert.equal(sourceContextAdapter(femaleSource).speakers[0].gender, 'female');
});

test('non-speech source events preserve their original sound evidence and source timestamps', () => {
  const source = sourceTranscript();
  const context = sourceContextAdapter(source);
  const event = context.nonSpeechEvents[0];
  assert.equal(event.eventId, 'source-event-1');
  assert.equal(event.type, 'audio_event');
  assert.equal(event.speakerId, null);
  assert.equal(event.startTime, 3.25);
  assert.equal(event.endTime, 3.75);
  assert.equal(event.evidence, 'door closes');
  assert.equal(event.text, 'door closes');
});

test('invalid canonical source timestamps fail instead of being repaired from caption or dub timecodes', () => {
  for (const [start, end] of [[-1, 2], [2, 2], [3, 2], [NaN, 2], [1, Infinity],
    [undefined, 2], [1, undefined], [null, 2], ['', 2], [false, 2], ['1', 2], [1, '2']]) {
    const source = sourceTranscript();
    source.utterances[0].sourceStart = start;
    source.utterances[0].sourceEnd = end;
    source.utterances[0].startTime = 1;
    source.utterances[0].endTime = 2;
    source.utterances[0].dubStart = 1;
    source.utterances[0].dubEnd = 2;
    assert.throws(() => sourceContextAdapter(source), undefined, `invalid canonical range ${String(start)}–${String(end)}`);
  }
});

test('missing canonical identities or original source text cannot authorize source evidence', () => {
  for (const [key, value] of [['segmentId', ''], ['speakerId', ''], ['sourceText', null], ['sourceText', undefined]]) {
    const source = sourceTranscript();
    source.utterances[0][key] = value;
    source.utterances[0].text = 'A generated fallback cannot replace missing source text.';
    assert.throws(() => sourceContextAdapter(source));
  }
  assert.throws(() => sourceContextAdapter({ segments: [{ text: 'legacy translation' }] }));
  assert.equal(sourceContextAdapter(null), null);
  assert.deepEqual(sourceContextAdapter({ utterances: [] }), {
    sourceLanguage: 'unknown', timestampUnit: 'seconds', segments: [], speakers: [], nonSpeechEvents: []
  });
});

test('source speech overlap compares only valid source ranges with a strict 40ms threshold', () => {
  const cases = [
    [{ startTime: 1, endTime: 2 }, { startTime: 1.5, endTime: 3 }, true],
    [{ startTime: 1, endTime: 2 }, { startTime: 2, endTime: 3 }, false],
    [{ startTime: 1, endTime: 2 }, { startTime: 3, endTime: 4 }, false],
    [{ startTime: 0, endTime: 0.04 }, { startTime: 0, endTime: 1 }, false],
    [{ startTime: 0, endTime: 0.040001 }, { startTime: 0, endTime: 1 }, true],
    [{ startTime: 1, endTime: 1 }, { startTime: 0, endTime: 2 }, false],
    [{ startTime: 2, endTime: 1 }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: -1, endTime: 2 }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: NaN, endTime: 2 }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: 0, endTime: Infinity }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: '0', endTime: 2 }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: 1 }, { startTime: 0, endTime: 3 }, false],
    [{ startTime: null, endTime: 2 }, { startTime: 0, endTime: 3 }, false],
    [{ sourceStart: 1, sourceEnd: 2, dubStart: 10, dubEnd: 20 }, { startTime: 10, endTime: 20 }, false]
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(sourceSpeechOverlaps(left, right), expected, JSON.stringify({ left, right }));
    assert.equal(sourceSpeechOverlaps(right, left), expected, 'overlap is symmetric');
  }
});
