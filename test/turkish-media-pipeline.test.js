import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaCache } from '../lib/turkish-media/cache.js';
import { createLimiter } from '../lib/turkish-media/limiter.js';
import { createTurkishMediaPipeline, dialogueBatches, splitDialogueText } from '../lib/turkish-media/pipeline.js';
import { createMediaJobs } from '../lib/turkish-media/jobs.js';
import { loadMediaConfig } from '../lib/turkish-media/config.js';
import { MediaError } from '../lib/turkish-media/errors.js';

const sourceWords = () => [{ text: 'Hello.', type: 'word', start: 1, end: 3, speaker_id: 'speaker_0' },
  { text: 'Yes.', type: 'word', start: 3.2, end: 5, speaker_id: 'speaker_1' }];
const voices = [{ voice_id: 'voice-a', name: 'Man', labels: { gender: 'male', language: 'tr' } },
  { voice_id: 'voice-b', name: 'Woman', labels: { gender: 'female', language: 'tr' } }];
const translatedText = row => row.sourceText === 'Hello.' ? 'Merhaba.' : 'Evet.';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { words = sourceWords(), failAlignmentOnce = false, missingAlignment = false,
  regeneration = false, missingTranslation = false, missingSplit = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vq-pipeline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source-video.mp4');
  await writeFile(sourcePath, 'fixed-source-video-bytes');
  const config = loadMediaConfig({ ELEVENLABS_API_KEY: 'eleven-server-key', GEMINI_API_KEY: 'gemini-server-key',
    DUB_CACHE_DIRECTORY: path.join(directory, 'cache') });
  const cache = createMediaCache({ directory: config.directory });
  const limiter = createLimiter(2);
  const calls = { extract: 0, transcribe: 0, translate: [], synthesize: [], align: [], mix: [], fit: [], join: [], logs: [] };
  let alignmentFailed = false;
  const audio = {
    async extractSource(_source, { directory: work }) {
      calls.extract += 1;
      const originalPath = path.join(work, 'original.wav'), sttPath = path.join(work, 'speech.flac');
      await writeFile(originalPath, 'original-source-audio');
      await writeFile(sttPath, 'full-source-speech');
      return { duration: 12, originalPath, sttPath };
    },
    async splitDialogueTurns(file, { directory: work, inputCount }) {
      await mkdir(work, { recursive: true });
      const generated = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(generated.turns.length, inputCount);
      const results = [];
      for (const [index, turn] of generated.turns.entries()) {
        const audioPath = path.join(work, `turn-${index}.wav`);
        await writeFile(audioPath, JSON.stringify({ text: turn.text, segmentId: turn.segmentId }));
        results.push({ dialogueInputIndex: index, audioPath, start: index, end: index + 1, duration: 1 });
      }
      return missingSplit ? results.slice(0, -1) : results;
    },
    async joinDialogueParts(files, { directory: work }) {
      await mkdir(work, { recursive: true });
      const parts = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
      assert.equal(new Set(parts.map(row => row.segmentId)).size, 1, 'chunks from different source occurrences must never join');
      const joined = { text: parts.map(row => row.text).join(' '), segmentId: parts[0].segmentId };
      const joinedPath = path.join(work, 'joined.wav');
      await writeFile(joinedPath, JSON.stringify(joined));
      calls.join.push({ files, parts });
      return { path: joinedPath, duration: files.length };
    },
    async fitDubSegment(file, { targetDuration, maxTempo }) {
      calls.fit.push({ file, targetDuration, maxTempo });
      const turn = JSON.parse(await readFile(file, 'utf8'));
      if (regeneration && turn.text === 'Merhaba.') {
        throw new MediaError('DUB_REGENERATE_REQUIRED', 'too long', { status: 422 });
      }
      const fittedPath = `${file}.fitted.wav`;
      await writeFile(fittedPath, JSON.stringify({ ...turn, fitted: true, duration: targetDuration }));
      return { path: fittedPath, duration: targetDuration, tempo: 1 };
    },
    async probeDuration() { return 3.5; },
    async mixAudio({ sourceAudio, dubSegments, duration, directory: work }) {
      assert.equal(await readFile(sourceAudio, 'utf8'), 'original-source-audio');
      for (const segment of dubSegments) assert.ok((await readFile(segment.audioPath)).length);
      calls.mix.push(dubSegments.map(row => ({ ...row })));
      const mixedPath = path.join(work, 'mixed.wav');
      await writeFile(mixedPath, 'mock-full-timeline-mix');
      return { path: mixedPath, duration, qa: { mixMode: 'speech-ducking', clipping: false } };
    },
  };
  const elevenLabs = {
    async transcribe(file) {
      calls.transcribe += 1;
      assert.equal(await readFile(file, 'utf8'), 'full-source-speech');
      return { language_code: 'en', text: words.map(row => row.text).join(' '), words };
    },
    async validateCapabilities() { return { modelId: 'eleven_v4', maxTextLength: 2000 }; },
    async listVoices() { return voices; },
    async synthesizeDialogue(turns) {
      calls.synthesize.push(structuredClone(turns));
      return { audio: Buffer.from(JSON.stringify({ turns })), model: 'eleven_v4', mimeType: 'audio/mpeg',
        outputFormat: 'mp3_44100_128', voiceSegments: turns.map((turn, i) => ({ voice_id: turn.voice_id,
          dialogue_input_index: i, start_time_seconds: i, end_time_seconds: i + 1 })) };
    },
    async align(file, text) {
      const actual = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(actual.text, text, 'Forced Alignment must use fitted Turkish bytes with the exact spoken transcript');
      assert.equal(actual.fitted, true);
      calls.align.push({ text, file, bytes: actual });
      if (failAlignmentOnce && !alignmentFailed) {
        alignmentFailed = true;
        throw new MediaError('PROVIDER_HTTP_503', 'temporary alignment failure', { retryable: true });
      }
      if (missingAlignment) return { words: [] };
      const tokens = text.split(' ');
      return { words: tokens.map((token, i) => ({ text: token, start: i * (actual.duration / tokens.length),
        end: (i + 1) * (actual.duration / tokens.length) - 0.02 })) };
    },
  };
  const translationProvider = {
    async translateScene(scene, options = {}) {
      calls.translate.push({ scene: structuredClone(scene), options });
      const rows = scene.utterances.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId,
        translatedText: options.shorten ? 'Selam.' : translatedText(row),
        displaySubtitleText: options.shorten ? 'Selam.' : translatedText(row),
        targetDuration: row.sourceEnd - row.sourceStart, estimatedDuration: 0.5 }));
      return missingTranslation ? rows.slice(0, -1) : rows;
    },
  };
  const pipeline = createTurkishMediaPipeline({ config, cache, limiter, elevenLabs, translationProvider, audio,
    log: entry => calls.logs.push(entry) });
  const input = { source: { path: sourcePath }, directory: path.join(directory, 'work'), outputs: { dub: true }, qualityMode: 'quality' };
  return { pipeline, config, cache, limiter, audio, elevenLabs, translationProvider, input, calls, directory, sourcePath };
}

test('pipeline logs every required stage with paired durations and IDs without source or spoken text', async t => {
  const f = await fixture(t);
  await f.pipeline(f.input, { jobId: 'job-stage-test' });
  const ends = f.calls.logs.filter(row => row.event === 'media_stage_end');
  for (const name of ['scribe', 'speaker_mapping', 'turkish_translation', 'elevenlabs_v4', 'forced_alignment', 'subtitle_generation', 'final_mix']) {
    assert.ok(ends.some(row => row.stage === name && row.outcome === 'completed'), `${name} must be observable`);
  }
  for (const end of ends) {
    const starts = f.calls.logs.filter(row => row.operationId === end.operationId && row.event === 'media_stage_start');
    assert.equal(starts.length, 1);
    assert.equal(end.jobId, 'job-stage-test');
    assert.ok(Number.isFinite(end.durationMs) && end.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(end.startedAt)) && Number.isFinite(Date.parse(end.endedAt)));
  }
  assert.equal(ends.filter(row => row.stage === 'forced_alignment' && row.segmentId).length, 2);
  const serialized = JSON.stringify(f.calls.logs);
  for (const privateValue of ['Hello.', 'Yes.', 'Merhaba.', 'Evet.', 'eleven-server-key', 'gemini-server-key']) {
    assert.ok(!serialized.includes(privateValue));
  }
});

test('final-package cache reuse logs cache hits instead of claiming new provider work', async t => {
  const f = await fixture(t);
  await f.pipeline(f.input);
  f.calls.logs.length = 0;
  await f.pipeline(f.input, { jobId: 'cached-job' });
  const ends = f.calls.logs.filter(row => row.event === 'media_stage_end' && row.stage !== 'pipeline');
  assert.equal(ends.length, 8);
  assert.ok(ends.every(row => row.outcome === 'cache_hit' && row.cacheScope === 'final-package'));
  assert.equal(f.calls.synthesize.length, 1);
  assert.equal(f.calls.transcribe, 1);
});

test('transcript-only logging marks unused media stages skipped and records Scribe completion', async t => {
  const f = await fixture(t);
  await f.pipeline({ ...f.input, outputs: { transcriptOnly: true } }, { jobId: 'source-only-job' });
  const ends = f.calls.logs.filter(row => row.event === 'media_stage_end');
  assert.ok(ends.some(row => row.stage === 'scribe' && row.outcome === 'completed'));
  const skipped = ends.filter(row => row.outcome === 'skipped');
  assert.equal(skipped.length, 6);
  assert.ok(skipped.every(row => row.reason === 'transcript_only'));
});

test('failed alignment logs the full redacted provider error and useful stack with its source segment', async t => {
  const f = await fixture(t);
  f.elevenLabs.align = async (_file, text) => {
    const error = new MediaError('PROVIDER_HTTP_422', `${'alignment-diagnostic '.repeat(120)}${text} eleven-server-key gemini-server-key final-error-marker`);
    error.stack = `${error.name}: ${error.message}\n    at mockedAlignment (provider.js:12:4)`;
    throw error;
  };
  await assert.rejects(f.pipeline(f.input, { jobId: 'failed-job' }), { code: 'PROVIDER_HTTP_422' });
  const failed = f.calls.logs.filter(row => row.stage === 'forced_alignment' && row.outcome === 'failed');
  assert.equal(failed.length, 2);
  assert.ok(failed.every(row => row.segmentId && row.jobId === 'failed-job' && row.error.message.length > 1500));
  assert.ok(failed.every(row => row.error.message.endsWith('final-error-marker') && row.error.stack.includes('provider.js:12:4')));
  const serialized = JSON.stringify(f.calls.logs);
  for (const privateValue of ['Merhaba.', 'Evet.', 'eleven-server-key', 'gemini-server-key']) assert.ok(!serialized.includes(privateValue));
});

test('pipeline retains all source identities and actual Forced Alignment offsets in both exported tracks', async t => {
  const f = await fixture(t);
  const stages = [];
  const telemetry = [];
  const result = await f.pipeline(f.input, { onStage: async row => { stages.push(row.state); telemetry.push(row); } });
  assert.equal(result.sourceTranscript.utterances.length, 2);
  assert.equal(result.translatedUtterances.length, 2);
  assert.equal(result.dubSegments.length, 2);
  assert.deepEqual(result.dubSegments.map(row => row.start), [1, 3.2]);
  assert.deepEqual(result.dubSegments.map(row => row.end), [3, 5]);
  assert.equal(result.dubSegments[1].words[0].start, 3.2);
  assert.equal(result.dubSegments[1].words[0].end, 4.98);
  assert.equal(new Set(Object.values(result.voiceMapping)).size, 2);
  assert.equal(f.calls.synthesize.length, 1);
  assert.equal(f.calls.synthesize[0].length, 2);
  assert.deepEqual(f.calls.synthesize[0].map(row => row.segmentId), result.sourceTranscript.utterances.map(row => row.segmentId));
  assert.equal(f.calls.align.length, 2);
  assert.equal(result.qualityReport.missingDubCount, 0);
  assert.equal(result.qualityReport.alignmentSuccessRate, 1);
  assert.ok(stages.includes('ALIGNING'));
  const aligned = telemetry.filter(row => row.state === 'ALIGNING' && row.stageProgress);
  assert.equal(aligned[0].stageProgress.loaded, 0);
  assert.equal(aligned.at(-1).stageProgress.loaded, f.calls.align.length);
  assert.equal(aligned.at(-1).stageProgress.total, result.dubSegments.length);
  assert.ok(aligned[0].completedStages.includes('GENERATING_DUB'));
  assert.equal(telemetry.find(row => row.state === 'TRANSCRIBING').stageProgress, null);
  assert.equal(telemetry.at(-1).stageProgress.loaded, 1);
  assert.ok(telemetry.at(-1).completedStages.includes('MIXING_AUDIO'));
  const sourceSrt = await f.cache.getArtifact(result.artifactKey, 'source_tr.srt');
  const dubVtt = await f.cache.getArtifact(result.artifactKey, 'dub_tr.vtt');
  assert.match(sourceSrt.toString(), /00:00:01,000 --> 00:00:03,000/);
  assert.match(sourceSrt.toString(), /Merhaba\./);
  assert.match(dubVtt.toString(), /00:00:03\.200 --> 00:00:04\.980/);
  assert.equal((await f.cache.getArtifact(result.artifactKey, 'mix.wav')).toString(), 'mock-full-timeline-mix');
});

test('overlapping source speakers keep independent turns and source intervals in mix/subtitles', async t => {
  const words = sourceWords();
  words[1].start = 2;
  words[1].end = 4;
  const f = await fixture(t, { words });
  const result = await f.pipeline(f.input);
  assert.deepEqual(result.dubSegments.map(row => [row.start, row.end]), [[1, 3], [2, 4]]);
  assert.equal(result.subtitles.source_tr[1].start, 2);
  assert.equal(result.subtitles.dub_tr[1].end, 3.98);
  assert.equal(f.calls.mix[0][0].speakerId !== f.calls.mix[0][1].speakerId, true);
  assert.equal(f.calls.synthesize.length, 2, 'real overlapping speakers need independent generation requests');
  assert.ok(f.calls.synthesize.every(turns => turns.length === 1));
});

test('repeat pipeline restores provider stages from real atomic disk cache', async t => {
  const f = await fixture(t);
  const first = await f.pipeline(f.input);
  const initialCalls = { transcribe: f.calls.transcribe, translate: f.calls.translate.length,
    synthesize: f.calls.synthesize.length, align: f.calls.align.length };
  const stats = {};
  const second = await f.pipeline({ ...f.input, directory: path.join(f.directory, 'second-work') }, { stats });
  assert.deepEqual(second.sourceTranscript, first.sourceTranscript);
  assert.deepEqual(second.voiceMapping, first.voiceMapping);
  assert.deepEqual({ transcribe: f.calls.transcribe, translate: f.calls.translate.length,
    synthesize: f.calls.synthesize.length, align: f.calls.align.length }, initialCalls);
  assert.ok(stats.cacheHits > 0);
});

test('failed alignment resumes from cached transcript, translation and generation without repeating synthesis', async t => {
  const f = await fixture(t, { failAlignmentOnce: true });
  await assert.rejects(f.pipeline(f.input), { code: 'PROVIDER_HTTP_503' });
  assert.equal(f.calls.synthesize.length, 1);
  assert.equal(f.calls.mix.length, 0);
  const result = await f.pipeline(f.input);
  assert.equal(result.dubSegments.length, 2);
  assert.equal(f.calls.synthesize.length, 1);
  assert.equal(f.calls.transcribe, 1);
  assert.equal(f.calls.translate.length, 1);
  assert.equal(f.calls.align.length, 3);
});

test('partial alignment retry preserves completed turns and generated pieces after whole-batch cache eviction', async t => {
  const f = await fixture(t);
  const generationKeys = [], completedKeys = [];
  const put = f.cache.put;
  f.cache.put = async (key, value, options) => {
    const result = await put(key, value, options);
    if (options?.artifacts?.['dialogue.audio']) generationKeys.push(key);
    if (options?.artifacts?.['segment.wav']) completedKeys.push(key);
    return result;
  };
  const align = f.elevenLabs.align;
  let failed = false;
  f.elevenLabs.align = async (file, text) => {
    const result = await align(file, text);
    if (text === 'Evet.' && !failed) {
      failed = true;
      throw new MediaError('PROVIDER_HTTP_503', 'temporary alignment failure', { retryable: true });
    }
    return result;
  };
  await assert.rejects(f.pipeline(f.input), { code: 'PROVIDER_HTTP_503' });
  assert.equal(generationKeys.length, 1);
  assert.equal(completedKeys.length, 1);
  const completed = await f.cache.get(completedKeys[0]);
  assert.equal(completed.translation.translatedText, 'Merhaba.');
  assert.equal(f.calls.synthesize.length, 1);
  for (const key of generationKeys) await rm(path.join(f.config.directory, `${key}.json`));
  await f.cache.removeExpired();
  assert.equal(await f.cache.get(generationKeys[0]), null, 'the original batch is genuinely unavailable');
  const result = await f.pipeline(f.input);
  assert.equal(result.dubSegments.length, 2);
  assert.equal(f.calls.synthesize.length, 1, 'a completed or already generated turn must not be charged again');
  assert.equal(f.calls.fit.length, 3, 'only the incomplete turn needs fitting again');
  assert.equal(f.calls.align.filter(row => row.text === 'Merhaba.').length, 1);
  assert.equal(f.calls.align.filter(row => row.text === 'Evet.').length, 2);
  assert.equal(f.calls.transcribe, 1);
  assert.equal(f.calls.translate.length, 1);
});

test('missing translation, native turn or Forced Alignment word fails instead of publishing partial media', async t => {
  for (const options of [{ missingTranslation: true }, { missingSplit: true }, { missingAlignment: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.pipeline(f.input), error => ['SEGMENT_COVERAGE_MISMATCH', 'DUB_MISSING_SEGMENTS', 'ALIGNMENT_MISSING_WORDS'].includes(error.code));
    assert.equal(f.calls.mix.length, 0);
  }
});

test('duration excess regenerates only the affected source turn and aligns actual shortened audio', async t => {
  const f = await fixture(t, { regeneration: true });
  const result = await f.pipeline(f.input);
  assert.equal(f.calls.synthesize.length, 2);
  assert.equal(f.calls.synthesize[1].length, 1);
  assert.equal(f.calls.synthesize[1][0].text, 'Selam.');
  assert.equal(f.calls.translate[1].options.shorten, true);
  assert.equal(Object.values(f.calls.translate[1].options.measuredDurations)[0], 3.5);
  assert.equal(result.translatedUtterances[0].translatedText, 'Selam.');
  assert.equal(result.dubSegments[0].start, 1);
  assert.equal(result.dubSegments[0].end, 3);
  assert.ok(f.calls.align.some(row => row.text === 'Selam.' && row.bytes.segmentId === result.dubSegments[0].segmentId));
});

test('alignment retry retains the already completed duration retranslation and audio generation', async t => {
  const f = await fixture(t, { regeneration: true, failAlignmentOnce: true });
  await assert.rejects(f.pipeline(f.input), { code: 'PROVIDER_HTTP_503' });
  assert.equal(f.calls.translate.length, 2);
  assert.equal(f.calls.synthesize.length, 2);
  const result = await f.pipeline(f.input);
  assert.equal(result.translatedUtterances[0].translatedText, 'Selam.');
  assert.equal(f.calls.translate.length, 2);
  assert.equal(f.calls.synthesize.length, 2);
});

test('transcript-only mode keeps ASR words and avoids translation, synthesis and mix', async t => {
  const f = await fixture(t);
  const result = await f.pipeline({ ...f.input, outputs: { transcriptOnly: true } });
  assert.equal(result.sourceTranscript.utterances.length, 2);
  assert.equal(result.qualityReport.transcriptOnly, true);
  assert.equal(f.calls.translate.length, 0);
  assert.equal(f.calls.synthesize.length, 0);
  assert.equal(f.calls.align.length, 0);
  assert.equal(f.calls.mix.length, 0);
});

test('subtitle-only mode translates source intervals without synthesizing voices or creating dub cues', async t => {
  const f = await fixture(t);
  const result = await f.pipeline({ ...f.input, outputs: { dub: false } });
  assert.equal(result.subtitles.source_tr.length, 2);
  assert.equal(result.subtitles.dub_tr.length, 0);
  assert.equal(f.calls.synthesize.length, 0);
  assert.equal(f.calls.align.length, 0);
});

test('a source containing only a real non-speech event creates no invented dialogue', async t => {
  const f = await fixture(t, { words: [{ text: '(laughter)', type: 'audio_event', start: 1, end: 2 }] });
  const result = await f.pipeline(f.input);
  assert.equal(result.sourceTranscript.utterances.length, 0);
  assert.equal(result.sourceTranscript.audioEvents.length, 1);
  assert.equal(result.sourceTranscript.audioEvents[0].text, '(laughter)');
  assert.equal(result.translatedUtterances.length, 0);
  assert.equal(result.dubSegments.length, 0);
  assert.equal(f.calls.translate.length, 0);
  assert.equal(f.calls.synthesize.length, 0);
  assert.equal(f.calls.align.length, 0);
  assert.equal(result.qualityReport.sourceDuration, 12);
  assert.equal(result.qualityReport.missingDubCount, 0);
});

test('dialogue batches respect provider text, voice and source-scene boundaries', () => {
  const utterances = Array.from({ length: 11 }, (_, i) => ({ segmentId: `s-${i}`, speakerId: `p-${i}`,
    sourceText: 'source', sourceStart: i, sourceEnd: i + 1 }));
  const translated = utterances.map(row => ({ ...row, translatedText: 'a'.repeat(150) }));
  const mapping = Object.fromEntries(utterances.map(row => [row.speakerId, row.speakerId]));
  assert.deepEqual(dialogueBatches(utterances, translated, mapping).map(rows => rows.length), [10, 1]);
  assert.deepEqual(dialogueBatches(utterances.slice(0, 2), translated, mapping, { characterLimit: 200 }).map(rows => rows.length), [1, 1]);
  const distant = [{ ...utterances[0] }, { ...utterances[1], sourceStart: 20, sourceEnd: 21 }];
  assert.equal(dialogueBatches(distant, translated, mapping).length, 2);
});

test('dialogue text splits on newlines and Unicode whitespace without dropping or cutting words', () => {
  for (const text of ['Bir\niki\nüç\ndört.', 'Bir\tiki\u00a0üç\u2003dört\u2028beş.', 'Bir iki.\nÜç dört.\tBeş.']) {
    const parts = splitDialogueText(text, 8);
    assert.ok(parts.length > 1);
    assert.ok(parts.every(part => part.length > 0 && part.length <= 8));
    assert.deepEqual(parts.flatMap(part => part.split(/\s+/u)), text.split(/\s+/u));
  }
});

async function completedJob(jobs, id) {
  for (let attempt = 0; attempt < 1250; attempt += 1) {
    const job = await jobs.get(id);
    if (['READY', 'FAILED', 'CANCELLED'].includes(job?.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  assert.fail('job did not settle');
}

test('real jobs count physical ElevenLabs retries, redact keys and recover persisted interruption', async t => {
  const f = await fixture(t);
  let fetchCalls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/speech-to-text');
    assert.equal(options.headers['xi-api-key'], 'eleven-server-key');
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response('rate limit', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ language_code: 'en', text: 'Hello. Yes.', words: sourceWords() });
  };
  f.config.maxRetries = 1;
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio, fetchImpl });
  const created = await jobs.create({ source: { path: f.sourcePath }, outputs: { transcriptOnly: true } });
  const ready = await completedJob(jobs, created.id);
  assert.equal(ready.state, 'READY', JSON.stringify(ready.error));
  assert.equal(fetchCalls, 2);
  assert.equal(ready.result.qualityReport.elevenLabsRequestCount, 2);
  assert.equal(ready.result.qualityReport.retryCount, 1);
  assert.ok(!JSON.stringify(ready).includes('eleven-server-key'));
  assert.ok(!JSON.stringify(ready).includes('gemini-server-key'));
  const interruptedId = 'b8eb5a12-f28d-4d23-b8ed-5d94cbbf5f1f';
  const interruptedPath = path.join(f.config.directory, 'jobs', interruptedId);
  await mkdir(interruptedPath, { recursive: true });
  await writeFile(path.join(interruptedPath, 'job.json'), JSON.stringify({ id: interruptedId,
    state: 'GENERATING_DUB', updatedAt: Date.now(), input: { source: { path: f.sourcePath }, outputs: { transcriptOnly: true } } }));
  const interrupted = await jobs.get(interruptedId);
  assert.equal(interrupted.state, 'FAILED');
  assert.equal(interrupted.error.code, 'JOB_INTERRUPTED');
});

test('jobs reject missing server keys and unverified fast before paying or creating work', async t => {
  const f = await fixture(t);
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio,
    fetchImpl: () => assert.fail('unexpected paid call') });
  await assert.rejects(jobs.create({ source: { path: f.sourcePath }, qualityMode: 'fast', outputs: { dub: true } }),
    { code: 'FAST_MODEL_PROTOCOL_UNVERIFIED' });
  f.config.elevenLabs.apiKey = '';
  await assert.rejects(jobs.create({ source: { path: f.sourcePath }, outputs: { transcriptOnly: true } }),
    { code: 'ELEVENLABS_NOT_CONFIGURED' });
});

test('job retry reuses completed source extraction after a failed provider stage', async t => {
  const f = await fixture(t);
  f.config.maxRetries = 0;
  let fetchCalls = 0;
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return new Response('temporary failure eleven-server-key', { status: 503 });
      return Response.json({ language_code: 'en', text: 'Hello. Yes.', words: sourceWords() });
    } });
  const initial = await jobs.create({ source: { path: f.sourcePath }, outputs: { transcriptOnly: true } });
  const failed = await completedJob(jobs, initial.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error.code, 'PROVIDER_HTTP_503');
  assert.equal(failed.qualityReport.sourceDuration, 12, 'failed ASR retains the measured source duration in QA');
  assert.ok(!failed.error.message.includes('eleven-server-key'));
  await jobs.retry(initial.id);
  const restored = await completedJob(jobs, initial.id);
  assert.equal(restored.state, 'READY');
  assert.equal(fetchCalls, 2);
  assert.equal(f.calls.extract, 1);
  assert.equal(restored.result.qualityReport.elevenLabsRequestCount, 1);
  assert.ok(restored.result.qualityReport.cacheHits > 0);
  assert.equal((await jobs.retry(initial.id)).state, 'READY');
  assert.equal(fetchCalls, 2);
});

test('retry waits for a failed owner to finish asynchronous source-lease release before relaunching', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.config.maxRetries = 0;
  const releaseStarted = deferred(), releaseGate = deferred();
  let fetchCalls = 0, leaseCalls = 0;
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio,
    leaseSource: () => {
      leaseCalls += 1;
      const firstOwner = leaseCalls === 1;
      return async () => {
        if (firstOwner) {
          releaseStarted.resolve();
          await releaseGate.promise;
        }
      };
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? new Response('temporary failure', { status: 503 })
        : Response.json({ language_code: 'en', text: 'Hello. Yes.', words: sourceWords() });
    } });
  try {
    const created = await jobs.create({ source: { path: f.sourcePath }, outputs: { transcriptOnly: true } });
    await releaseStarted.promise;
    assert.equal((await jobs.get(created.id)).state, 'FAILED');
    let retryReturned = false;
    const retried = jobs.retry(created.id).then(result => { retryReturned = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retryReturned, false, 'retry must wait while the terminal owner is still releasing its lease');
    assert.equal(leaseCalls, 1);
    assert.equal(fetchCalls, 1);
    releaseGate.resolve();
    assert.equal((await retried).state, 'PREPARING_AUDIO');
    const ready = await completedJob(jobs, created.id);
    assert.equal(ready.state, 'READY', JSON.stringify(ready.error));
    assert.equal(leaseCalls, 2);
    assert.equal(fetchCalls, 2);
    assert.equal(f.calls.extract, 1);
  } finally { releaseGate.resolve(); }
});

test('cancelling the first queued video never aborts the second job sharing its source cache', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.config.maxRetries = 0;
  const firstFetch = deferred(), secondLeased = deferred();
  let fetchCalls = 0, leaseCalls = 0, firstSignal, secondSignal;
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio,
    leaseSource: () => {
      leaseCalls += 1;
      if (leaseCalls === 2) secondLeased.resolve();
      return () => {};
    },
    fetchImpl: async (_url, { signal }) => {
      fetchCalls += 1;
      assert.equal(signal.aborted, false);
      if (fetchCalls === 1) {
        firstSignal = signal;
        firstFetch.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      secondSignal = signal;
      assert.equal(firstSignal.aborted, true, 'the second pipeline must start after the cancelled owner settles');
      return Response.json({ language_code: 'en', text: 'Hello. Yes.', words: sourceWords() });
    } });
  const input = { source: { path: f.sourcePath }, outputs: { transcriptOnly: true } };
  const first = await jobs.create(input);
  await firstFetch.promise;
  const second = await jobs.create(input);
  await secondLeased.promise;
  assert.equal(fetchCalls, 1, 'the shared source must have only one active pipeline');
  await jobs.cancel(first.id);
  const [cancelled, ready] = await Promise.all([completedJob(jobs, first.id), completedJob(jobs, second.id)]);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(ready.state, 'READY', JSON.stringify(ready.error));
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(secondSignal.aborted, false);
  assert.equal(fetchCalls, 2);
  assert.equal(f.calls.extract, 1, 'the second job reuses the prepared source instead of re-extracting it');
  assert.equal(ready.result.qualityReport.elevenLabsRequestCount, 1);
  assert.ok(ready.result.qualityReport.cacheHits > 0);
});

test('cancelling a live job aborts provider work and retry uses a fresh signal', async t => {
  const f = await fixture(t);
  let notifyFetch;
  const fetching = new Promise(resolve => { notifyFetch = resolve; });
  let fetchCalls = 0;
  const jobs = createMediaJobs({ config: f.config, cache: f.cache, limiter: f.limiter, audio: f.audio,
    fetchImpl: async (_url, { signal }) => {
      fetchCalls += 1;
      assert.equal(signal.aborted, false);
      if (fetchCalls > 1) return Response.json({ language_code: 'en', text: 'Hello. Yes.', words: sourceWords() });
      notifyFetch();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  const created = await jobs.create({ source: { path: f.sourcePath }, outputs: { transcriptOnly: true } });
  await fetching;
  await jobs.cancel(created.id);
  const cancelled = await completedJob(jobs, created.id);
  assert.equal(cancelled.state, 'CANCELLED');
  await jobs.retry(created.id);
  const ready = await completedJob(jobs, created.id);
  assert.equal(ready.state, 'READY');
  assert.equal(fetchCalls, 2);
  assert.equal(f.calls.extract, 1);
});

test('actual model text limit shapes dialogue batches before synthesis', async t => {
  const f = await fixture(t);
  f.elevenLabs.validateCapabilities = async () => ({ modelId: 'eleven_v4', maxTextLength: 10 });
  const synthesize = f.elevenLabs.synthesizeDialogue;
  f.elevenLabs.synthesizeDialogue = async turns => {
    assert.ok(turns.reduce((count, turn) => count + turn.text.length, 0) <= 10,
      'each paid batch must fit the live model limit');
    return synthesize(turns);
  };
  const result = await f.pipeline(f.input);
  assert.equal(result.dubSegments.length, 2);
  assert.equal(f.calls.synthesize.length, 2);
});

test('a long translated turn keeps every word and one source identity across bounded same-voice chunks', async t => {
  const f = await fixture(t, { words: [{ text: 'Hello.', type: 'word', start: 1, end: 10, speaker_id: 'speaker_0' }] });
  const text = 'Bir iki üç dört beş altı yedi sekiz dokuz on.';
  const limit = 12;
  f.elevenLabs.validateCapabilities = async () => ({ modelId: 'eleven_v4', maxTextLength: limit });
  const synthesize = f.elevenLabs.synthesizeDialogue;
  f.elevenLabs.synthesizeDialogue = async turns => {
    assert.ok(turns.reduce((count, turn) => count + turn.text.length, 0) <= limit,
      'all paid payloads must obey the actual model limit');
    return synthesize(turns);
  };
  f.translationProvider.translateScene = async (scene, options = {}) => {
    assert.ok(options.shorten !== true, 'the translation fits its source interval; length limits require lossless chunks');
    f.calls.translate.push({ scene, options });
    return scene.utterances.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId,
      translatedText: text, displaySubtitleText: text, targetDuration: row.sourceEnd - row.sourceStart, estimatedDuration: 5 }));
  };
  const result = await f.pipeline(f.input);
  const parts = f.calls.synthesize.flat().sort((a, b) => a.partIndex - b.partIndex);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(row => row.text).join(' '), text);
  assert.equal(new Set(parts.map(row => row.segmentId)).size, 1);
  assert.equal(new Set(parts.map(row => row.speakerId)).size, 1);
  assert.equal(new Set(parts.map(row => row.voice_id)).size, 1);
  assert.equal(result.translatedUtterances.length, 1);
  assert.equal(result.translatedUtterances[0].translatedText, text);
  assert.equal(result.dubSegments.length, 1);
  assert.equal(result.dubSegments[0].segmentId, parts[0].segmentId);
  assert.equal(result.dubSegments[0].start, 1);
  assert.equal(result.dubSegments[0].end, 10);
  assert.equal(result.dubSegments[0].words.map(row => row.text).join(' '), text);
  assert.equal(f.calls.join.length, 1);
  assert.equal(f.calls.fit.length, 1);
  assert.equal(f.calls.align.length, 1);
  assert.equal(f.calls.align[0].text, text);
  assert.equal(f.calls.align[0].bytes.text, text);
});

test('cache eviction cannot delete prepared source audio while a provider is consuming it', async t => {
  const f = await fixture(t);
  let now = 0;
  const cache = createMediaCache({ directory: f.config.directory, ttlSeconds: 60, clock: () => now });
  const transcribe = f.elevenLabs.transcribe;
  f.elevenLabs.transcribe = async file => {
    now = 61000;
    await cache.removeExpired();
    return transcribe(file);
  };
  const pipeline = createTurkishMediaPipeline({ config: f.config, cache, limiter: f.limiter,
    elevenLabs: f.elevenLabs, translationProvider: f.translationProvider, audio: f.audio });
  const result = await pipeline(f.input);
  assert.equal(result.dubSegments.length, 2);
  assert.equal(f.calls.mix.length, 1);
});
