import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeScribeTranscript, applySpeakerHints, assertSegmentCoverage, sourceContextAdapter } from '../lib/turkish-media/model.js';
import { buildSubtitleTracks, normalizeDubWords, toSrt, toWebVtt } from '../lib/turkish-media/subtitles.js';
import { createMediaCache, hashKey } from '../lib/turkish-media/cache.js';
import { createLimiter } from '../lib/turkish-media/limiter.js';
import { mapSpeakerVoices } from '../lib/turkish-media/voice-mapping.js';

const word = (text, start, end, speaker_id = 'speaker_0', extra = {}) => ({ text, start, end, speaker_id, type: 'word', logprob: -0.15, ...extra });
const fixture = () => normalizeScribeTranscript({ language_code: 'en', words: [
  word('Hello.', 1, 1.8),
  { text: ' ', start: 1.8, end: 2, type: 'spacing', provider_extra: 'retained' },
  word('Welcome.', 2, 3),
  word('Thank', 2.4, 2.7, 'speaker_1'),
  { text: ' ', start: 2.7, end: 2.7, type: 'spacing' },
  word('you!', 2.7, 3.4, 'speaker_1'),
  { text: '(laughter)', start: 3.5, end: 4, type: 'audio_event', speaker_id: 'speaker_1', logprob: -.3 },
  word('Hello.', 8, 9)
] }, { sourceHash: 'same-video', duration: 12 });
const translationsFor = transcript => transcript.utterances.map((row, index) => ({
  segmentId: row.segmentId, speakerId: row.speakerId,
  translatedText: ['Merhaba.', 'Hoş geldiniz.', 'Teşekkür ederim!', 'Merhaba.'][index] || 'Türkçe cümle.',
  displaySubtitleText: '', targetDuration: row.sourceEnd - row.sourceStart, estimatedDuration: null
}));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('canonical transcript preserves every speech word, spacing metadata, repeated line and overlapping speaker', () => {
  const transcript = fixture();
  assert.equal(transcript.version, 1);
  assert.deepEqual(transcript.source, { hash: 'same-video', duration: 12 });
  assert.equal(transcript.utterances.length, 4);
  assert.equal(transcript.speakers.length, 2);
  assert.equal(transcript.utterances.flatMap(row => row.words).filter(row => row.type === 'word').length, 5);
  assert.deepEqual(transcript.utterances.map(row => [row.sourceStart, row.sourceEnd]), [[1, 1.8], [2, 3], [2.4, 3.4], [8, 9]]);
  assert.equal(transcript.utterances[2].sourceText, 'Thank you!');
  assert.equal(transcript.utterances[0].words[1].provider_extra, 'retained');
  assert.equal(transcript.audioEvents[0].text, '(laughter)');
  assert.equal(transcript.audioEvents[0].logprob, -.3);
  assert.equal(transcript.audioEvents[0].speakerId, transcript.utterances[2].speakerId);
  assert.ok(transcript.speakers.every(row => row.gender === null && row.emotion === null));
  assert.ok(transcript.utterances.every(row => row.confidence === null && row.gender === null));
  assert.equal(transcript.utterances[0].speakerId, transcript.utterances[3].speakerId);
  assert.notEqual(transcript.utterances[0].segmentId, transcript.utterances[3].segmentId);
});

test('verified visual speaker hints collapse Scribe fragments into stable logical speakers', () => {
  const raw = normalizeScribeTranscript({ language_code: 'en', words: [
    word('Hello.', 0, 1, 'raw_male_a'),
    word('Again.', 2, 3, 'raw_male_b'),
    word('Hi.', 4, 5, 'raw_female_a'),
    word('Sure.', 6, 7, 'raw_female_b')
  ] }, { sourceHash: 'four-raw-two-real', duration: 8 });
  assert.equal(raw.speakers.length, 4);
  const byProvider = Object.fromEntries(raw.speakers.map(row => [row.providerId, row.speakerId]));
  const merged = applySpeakerHints(raw, {
    [byProvider.raw_male_a]: { characterId: 'MAIN_MALE', gender: 'male', emotion: 'excited', tone: 'energetic' },
    [byProvider.raw_male_b]: { characterId: 'MAIN_MALE', gender: 'male', emotion: 'excited', tone: 'energetic' },
    [byProvider.raw_female_a]: { characterId: 'PARTNER_A', gender: 'female', emotion: 'calm', tone: 'warm' },
    [byProvider.raw_female_b]: { characterId: 'PARTNER_A', gender: 'female', emotion: 'calm', tone: 'warm' },
  });
  assert.equal(merged.speakers.length, 2);
  assert.deepEqual(new Set(merged.utterances.slice(0, 2).map(row => row.speakerId)).size, 1);
  assert.deepEqual(new Set(merged.utterances.slice(2).map(row => row.speakerId)).size, 1);
  assert.notEqual(merged.utterances[0].speakerId, merged.utterances[2].speakerId);
  assert.equal(merged.speakers.find(row => row.characterId === 'MAIN_MALE').gender, 'male');
  assert.equal(merged.speakers.find(row => row.characterId === 'MAIN_MALE').emotion, 'excited');
  assert.equal(merged.speakers.find(row => row.characterId === 'PARTNER_A').tone, 'warm');
  assert.equal(raw.speakers.length, 4, 'raw Scribe evidence is not mutated');
});

test('automatic voice allocation ranks Turkish gender tone and emotion labels without asking the user', () => {
  const speakers = [
    { speakerId: 'male', gender: 'male', emotion: 'excited', tone: 'energetic' },
    { speakerId: 'female', gender: 'female', emotion: 'calm', tone: 'warm' },
  ];
  const catalog = [
    { voice_id: 'male-neutral', name: 'Male Neutral', labels: { gender: 'male', language: 'tr', style: 'neutral conversational' } },
    { voice_id: 'male-energy', name: 'Male Energy', labels: { gender: 'male', language: 'tr', style: 'energetic excited dynamic' } },
    { voice_id: 'female-bright', name: 'Female Bright', labels: { gender: 'female', language: 'tr', style: 'bright upbeat' } },
    { voice_id: 'female-calm', name: 'Female Calm', labels: { gender: 'female', language: 'tr', style: 'calm warm gentle' } },
  ];
  assert.deepEqual(mapSpeakerVoices(speakers, catalog), {
    male: 'male-energy',
    female: 'female-calm',
  });
});

test('canonical IDs are deterministic for source bytes and provider speaker mapping, and inputs remain untouched', () => {
  const source = { language_code: 'tr', words: [word('Günaydın!', 0, 1, 'speaker_7', { confidence: .8 })] };
  const original = structuredClone(source);
  const a = normalizeScribeTranscript(source, { sourceHash: 'video-a', duration: 2 });
  const b = normalizeScribeTranscript(source, { sourceHash: 'video-a', duration: 2 });
  const c = normalizeScribeTranscript(source, { sourceHash: 'video-b', duration: 2 });
  assert.deepEqual(a, b);
  assert.notEqual(a.utterances[0].segmentId, c.utterances[0].segmentId);
  assert.equal(a.speakers[0].providerId, 'speaker_7');
  assert.equal(a.utterances[0].confidence, .8);
  assert.deepEqual(source, original);
});

test('invalid or untimed meaningful speech fails instead of becoming a silent successful transcript', () => {
  for (const words of [[word('Hello', -1, 1)], [word('Hello', 1, 0)], [word('Hello', 1, 13)],
    [word('Hello', NaN, 1)], [word('Hello', '1', 2)]]) {
    assert.throws(() => normalizeScribeTranscript({ words }, { sourceHash: 'video', duration: 12 }));
  }
  assert.throws(() => normalizeScribeTranscript({ text: 'Actual source speech', words: [] }, { sourceHash: 'video', duration: 12 }), /TIMING_MISSING/);
  assert.throws(() => normalizeScribeTranscript({ words: [word('source', 0, 1, 'a', { type: 'unknown' })] }, { sourceHash: 'video', duration: 12 }), /UNKNOWN_SCRIBE_WORD_TYPE/);
  const silent = normalizeScribeTranscript({ text: '', words: [] }, { sourceHash: 'video', duration: 12 });
  assert.deepEqual(silent.utterances, []);
});

test('provider-rounded zero-duration speech is repaired without mutating Scribe word evidence', () => {
  const source = { language_code: 'en', words: [
    word('Yes.', 1, 1),
    word('Next', 1.4, 2),
    word('Done', 12, 12)
  ] };
  const original = structuredClone(source);
  const transcript = normalizeScribeTranscript(source, { sourceHash: 'zero-duration-video', duration: 12 });

  assert.equal(transcript.utterances.length, 3);
  assert.deepEqual(transcript.utterances.map(row => [row.sourceStart, row.sourceEnd]), [
    [1, 1.4],
    [1.4, 2],
    [11.5, 12],
  ]);
  assert.equal(transcript.utterances[0].timingRepair, 'zero-duration-provider-timestamp');
  assert.equal(transcript.utterances[2].timingRepair, 'zero-duration-provider-timestamp');
  assert.equal(transcript.utterances[0].words.find(row => row.type === 'word').start, 1);
  assert.equal(transcript.utterances[0].words.find(row => row.type === 'word').end, 1);
  assert.equal(transcript.utterances[2].words.find(row => row.type === 'word').start, 12);
  assert.equal(transcript.utterances[2].words.find(row => row.type === 'word').end, 12);
  assert.deepEqual(source, original);
});

test('zero-duration speech before an equal next boundary is backfilled instead of overlapping the next turn', () => {
  const transcript = normalizeScribeTranscript({ words: [
    word('Wait.', 3, 3, 'speaker_0'),
    word('Now', 3, 3.6, 'speaker_1')
  ] }, { sourceHash: 'equal-boundary-video', duration: 5 });

  assert.equal(transcript.utterances[0].sourceEnd, 3);
  assert.equal(transcript.utterances[0].sourceStart, 2.5);
  assert.equal(transcript.utterances[0].timingRepair, 'zero-duration-provider-timestamp');
  assert.equal(transcript.utterances[1].sourceStart, 3);
});

test('translation and dub coverage rejects missing, duplicate, foreign or mutated identities and preserves source evidence', () => {
  const source = fixture(), translated = translationsFor(source);
  assert.equal(assertSegmentCoverage(source, [...translated].reverse()), true);
  assert.equal(assertSegmentCoverage(source, translated, translated.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId }))), true);
  for (const changed of [translated.slice(1), [...translated, translated[0]],
    translated.map((row, i) => i ? row : { ...row, segmentId: 'foreign' }),
    translated.map((row, i) => i ? row : { ...row, speakerId: translated[2].speakerId }),
    translated.map((row, i) => i ? row : { ...row, sourceStart: 11 }),
    translated.map((row, i) => i ? row : { ...row, sourceText: 'Invented source' }),
    translated.map((row, i) => i ? row : { ...row, translatedText: '' })]) {
    assert.throws(() => assertSegmentCoverage(source, changed));
  }
  assert.throws(() => assertSegmentCoverage(source, translated, []), /COVERAGE/);
});

test('gameplay source adapter keeps source timestamps and does not label untranslated English as Turkish', () => {
  const source = fixture();
  const original = sourceContextAdapter(source);
  assert.equal(original.segments[0].originalText, 'Hello.');
  assert.equal(original.segments[0].text, 'Hello.');
  assert.equal(original.segments[0].textTr, '');
  assert.equal(original.segments[0].turkishText, '');
  assert.equal(original.segments[0].gender, 'uncertain');
  const translated = sourceContextAdapter(source, translationsFor(source));
  assert.equal(translated.segments[0].textTr, 'Merhaba.');
  assert.deepEqual(translated.segments.map(row => [row.startTime, row.endTime]), source.utterances.map(row => [row.sourceStart, row.sourceEnd]));
  assert.equal(translated.nonSpeechEvents[0].startTime, 3.5);
});

test('source captions use whole source intervals without invented Turkish word times; aligned dub captions retain actual overlapping intervals', () => {
  const source = fixture(), translated = translationsFor(source);
  const dubs = source.utterances.map((row, index) => ({ segmentId: row.segmentId, speakerId: row.speakerId,
    start: row.sourceStart, end: row.sourceEnd, words: [{ text: translated[index].translatedText,
      start: row.sourceStart + .1, end: row.sourceEnd - .05 }] }));
  const tracks = buildSubtitleTracks(source, translated, dubs);
  assert.equal(tracks.source_tr.length, 4);
  assert.ok(tracks.source_tr.every(row => row.words.length === 0));
  assert.deepEqual(tracks.source_tr.map(row => [row.start, row.end]), source.utterances.map(row => [row.sourceStart, row.sourceEnd]));
  assert.equal(tracks.dub_tr[0].start, 1.1);
  assert.equal(tracks.dub_tr[0].end, 1.75);
  assert.deepEqual(tracks.dub_tr[0].words, dubs[0].words);
  assert.ok(tracks.dub_tr[1].end > tracks.dub_tr[2].start, 'independent speakers retain real overlap');
  dubs[0].words[0].start = 0;
  assert.throws(() => buildSubtitleTracks(source, translated, dubs), /INVALID_DUB_WORD_ALIGNMENT/);
});

test('word clocks snap only sample-sized drift and diagnose genuine invalid timing without changing words', () => {
  const options = { start: 2, end: 3, segmentId: 'segment-boundary' };
  const words = [{ text: 'Merhaba', start: 2 - 1e-10, end: 2.5 },
    { text: 'dostum.', start: 2.5, end: 3 + 1 / 96000 }];
  const normalized = normalizeDubWords(words, options);
  assert.deepEqual(normalized.map(word => word.text), words.map(word => word.text));
  assert.equal(normalized[0].start, 2); assert.equal(normalized[1].end, 3);
  assert.ok(words[0].start < 2 && words[1].end > 3, 'provider evidence is not mutated');
  for (const [invalid, reason] of [
    [[{ text: 'Merhaba', start: 2, end: 3.001 }], 'word_outside_dub_window'],
    [[{ text: 'Merhaba', start: 1.999, end: 2.5 }], 'word_outside_dub_window'],
    [[{ text: 'Merhaba', start: 2.5, end: 2.7 }, { text: 'dostum.', start: 2.4, end: 2.8 }], 'word_clock_runs_backwards'],
    [[{ text: 'Merhaba', start: 2.5, end: 2.5 }], 'invalid_word_interval'],
    [[{ text: 'Merhaba', start: NaN, end: 2.5 }], 'invalid_word_interval']
  ]) assert.throws(() => normalizeDubWords(invalid, options), error =>
    error.code === 'INVALID_DUB_WORD_ALIGNMENT' && error.reason === reason &&
    error.segmentIds[0] === options.segmentId && Number.isInteger(error.wordIndex));
});

test('mobile captions preserve long text with two lines and warnings; dub grouping uses only real word boundaries', () => {
  const source = normalizeScribeTranscript({ words: [word('Long source sentence.', 1, 20)] }, { sourceHash: 'long', duration: 30 });
  const longText = Array.from({ length: 40 }, (_, i) => `sözcük${i}`).join(' ');
  const translated = [{ ...translationsFor(source)[0], translatedText: longText }];
  const words = Array.from({ length: 40 }, (_, i) => ({ text: `sözcük${i}`, start: 1 + i * .4, end: 1.3 + i * .4 }));
  const tracks = buildSubtitleTracks(source, translated, [{ segmentId: source.utterances[0].segmentId,
    speakerId: source.utterances[0].speakerId, words }]);
  assert.equal(tracks.source_tr[0].text.split('\n').length, 2);
  assert.equal(tracks.source_tr[0].text.replace(/\s+/gu, ' '), longText);
  assert.ok(tracks.source_tr[0].warnings.includes('SUBTITLE_LINE_TOO_LONG'));
  assert.ok(tracks.dub_tr.length > 1);
  assert.deepEqual(tracks.dub_tr.flatMap(row => row.words), words);
  assert.ok(tracks.dub_tr.every(row => row.text.split('\n').length <= 2));
  for (const cue of tracks.dub_tr) {
    assert.equal(cue.start, cue.words[0].start);
    assert.equal(cue.end, cue.words.at(-1).end);
  }
});

test('subtitle exports retain UTF-8 and valid timing, while VTT source markup remains literal', () => {
  const cues = [{ start: 1.005, end: 3661.123, text: 'İşte çığlık: <b>şimdi</b> & sonra\nİkinci satır.' }];
  const srt = toSrt(cues), vtt = toWebVtt(cues);
  assert.match(srt, /00:00:01,005 --> 01:01:01,123/);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.005 --> 01:01:01\.123/);
  assert.ok(vtt.includes('&lt;b&gt;şimdi&lt;/b&gt; &amp; sonra'));
  assert.equal(Buffer.from(srt, 'utf8').toString('utf8'), srt);
  assert.throws(() => toSrt([{ start: 2, end: 1, text: 'bad' }]));
});

async function cacheFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vq-turkish-core-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 10_000;
  const cache = createMediaCache({ directory, ttlSeconds: 1, clock: () => now });
  return { directory, cache, advance: ms => { now += ms; } };
}

test('cache hashes stable JSON and real binary bytes with distinct content domains', () => {
  assert.equal(hashKey({ speaker: 'a', nested: { z: 1, a: 2 } }), hashKey({ nested: { a: 2, z: 1 }, speaker: 'a' }));
  assert.equal(hashKey(Buffer.from([1, 2])), hashKey(new Uint8Array([1, 2])));
  assert.equal(hashKey(new Uint8Array([1, 2]).buffer), hashKey(Buffer.from([1, 2])));
  assert.notEqual(hashKey(Buffer.from('same')), hashKey('same'));
  assert.notEqual(hashKey({ model: 'a', bytes: Buffer.from([1]) }), hashKey({ model: 'b', bytes: Buffer.from([1]) }));
});

test('cache atomically restores JSON and checksum-verified artifacts after reopening, rejects traversal and expires at TTL', async t => {
  const f = await cacheFixture(t), key = hashKey('job');
  await f.cache.put(key, { stage: 'aligned', count: 2 }, { artifacts: { 'dub.wav': Buffer.from('actual audio bytes') } });
  assert.deepEqual(await f.cache.get(key), { stage: 'aligned', count: 2 });
  assert.deepEqual(await f.cache.getArtifact(key, 'dub.wav'), Buffer.from('actual audio bytes'));
  const audioPath = await f.cache.getArtifactPath(key, 'dub.wav');
  assert.equal(await readFile(audioPath, 'utf8'), 'actual audio bytes');
  const reopened = createMediaCache({ directory: f.directory, ttlSeconds: 1, clock: () => 10_000 });
  assert.deepEqual(await reopened.get(key), { stage: 'aligned', count: 2 });
  await assert.rejects(f.cache.get('../escape'));
  await assert.rejects(f.cache.put(key, {}, { artifacts: { '../escape': Buffer.from('bad') } }));
  await assert.rejects(f.cache.getArtifact(key, '../../escape'));
  f.advance(1001);
  assert.equal(await f.cache.get(key), null);
  assert.equal(await f.cache.getArtifact(key, 'dub.wav'), null);
  assert.equal(await f.cache.removeExpired(), 1);
});

test('cache corruption never becomes a hit and active leases prevent TTL deletion without extending TTL', async t => {
  const f = await cacheFixture(t), key = hashKey('corrupt');
  await f.cache.put(key, { value: 'original' }, { artifacts: { 'dub.wav': Buffer.from('audio') } });
  const audioPath = await f.cache.getArtifactPath(key, 'dub.wav');
  await writeFile(audioPath, 'broken audio');
  assert.equal(await f.cache.get(key), null);
  assert.equal(await f.cache.getArtifact(key, 'dub.wav'), null);
  await f.cache.put(key, { value: 'renewed' });
  const release = f.cache.acquireLease(key);
  f.advance(1001);
  assert.equal(await f.cache.get(key), null);
  assert.equal(await f.cache.removeExpired(), 0);
  release(); release();
  assert.equal(await f.cache.removeExpired(), 1);
});

test('cache accepts disk-backed artifacts and publishes an independent checksum-verified file', async t => {
  const f = await cacheFixture(t), key = hashKey('disk-backed');
  const sourcePath = path.join(f.directory, 'prepared.wav');
  await writeFile(sourcePath, 'streamed prepared speech');
  await f.cache.put(key, { stage: 'audio' }, { artifacts: { 'dub.wav': { path: sourcePath } } });
  const cachedPath = await f.cache.getArtifactPath(key, 'dub.wav');
  assert.notEqual(cachedPath, sourcePath);
  await rm(sourcePath);
  assert.equal(await readFile(cachedPath, 'utf8'), 'streamed prepared speech');
  assert.deepEqual(await f.cache.get(key), { stage: 'audio' });
});

test('failed atomic artifact publication leaves the previous successful entry intact and altered JSON is not a hit', async t => {
  const f = await cacheFixture(t), key = hashKey('atomic');
  await f.cache.put(key, { stage: 'complete' });
  await assert.rejects(f.cache.put(key, { stage: 'broken' }, { artifacts: { 'dub.wav': { path: path.join(f.directory, 'missing.wav') } } }));
  assert.deepEqual(await f.cache.get(key), { stage: 'complete' });
  const manifestPath = path.join(f.directory, `${key}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.value.stage = 'tampered';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(await f.cache.get(key), null);
});

test('single-flight shares one pending job, protects cleanup and releases a failed job for retry', async t => {
  const f = await cacheFixture(t), key = hashKey('pending');
  await f.cache.put(key, { stage: 'existing' });
  const pending = defer(); let calls = 0;
  const one = f.cache.singleFlight(key, async () => { calls++; await pending.promise; return 'done'; });
  const two = f.cache.singleFlight(key, () => { throw Error('duplicate job started'); });
  assert.equal(one, two);
  await Promise.resolve();
  assert.equal(calls, 1);
  f.advance(1001);
  assert.equal(await f.cache.removeExpired(), 0, 'active job lease prevents deleting its artifact generation');
  pending.resolve();
  assert.equal(await one, 'done');
  assert.equal(await f.cache.removeExpired(), 1);
  await assert.rejects(f.cache.singleFlight(key, () => { throw Error('provider failed'); }), /provider failed/);
  assert.equal(await f.cache.singleFlight(key, async () => 'retried'), 'retried');
});

test('limiter bounds work and a queued abort never starts, while active cancellation holds its slot until settlement', async () => {
  const limiter = createLimiter(1), first = defer(), second = defer();
  const abortActive = new AbortController(), abortQueued = new AbortController();
  let activeSignal, queuedStarted = false, lastStarted = false;
  const running = limiter.run(async signal => { activeSignal = signal; await first.promise; return 'first'; }, { signal: abortActive.signal });
  const queued = limiter.run(() => { queuedStarted = true; }, { signal: abortQueued.signal });
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  const last = limiter.run(async () => { lastStarted = true; await second.promise; return 'last'; });
  await Promise.resolve();
  abortQueued.abort(); abortActive.abort();
  await queuedRejected;
  assert.equal(activeSignal.aborted, true);
  assert.equal(queuedStarted, false);
  assert.equal(lastStarted, false);
  first.resolve();
  assert.equal(await running, 'first');
  await Promise.resolve();
  assert.equal(lastStarted, true);
  second.resolve();
  assert.equal(await last, 'last');
  await assert.rejects(limiter.run(() => { throw Error('synchronous failure'); }), /synchronous failure/);
  assert.equal(await limiter.run(async () => 'slot recovered'), 'slot recovered');
});

test('limiter enforces its configured concurrent peak and rejects pre-aborted calls', async () => {
  const limiter = createLimiter(2);
  const gates = [defer(), defer(), defer()]; let active = 0, peak = 0;
  const tasks = gates.map(gate => limiter.run(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; }));
  await Promise.resolve();
  assert.equal(active, 2);
  gates[0].resolve(); await tasks[0];
  await Promise.resolve();
  assert.equal(active, 2);
  gates[1].resolve(); gates[2].resolve(); await Promise.all(tasks);
  assert.equal(peak, 2);
  await assert.rejects(limiter.run(() => assert.fail('aborted task ran'), { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
  assert.throws(() => createLimiter(0));
});
