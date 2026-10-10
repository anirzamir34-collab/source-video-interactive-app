import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAnalysisProgress } from '../public/analysis-progress.js';
import { sourceContextAdapter } from '../public/source-transcript.js';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `application integration section exists: ${start}`);
  return appSource.slice(from, to);
}

const branch = section('// The URL cache supplies one complete local source', '  const remoteStoryboardSource');
const visualRequest = section('  const remoteStoryboardSource', '\n    const stopped = await runContextualAnalysisChunks');
const handlerFailure = section("  } catch (error) {\n    console.error('Analysis failed:'", '\n});\n\nfunction assignPositionOccurrenceIds(');
const updateTranscript = section('function updateSourceTranscript(', '\nfunction onTurkishMediaStatus(');
const selectedModes = section('function selectedAnalysisModes(', '\nfunction updateAnalysisModesUI(');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

class Element {
  dataset = {};
  textContent = '';
  checked = false;
  value = '';
  classes = new Set(['hidden']);
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
  };
}

function sourceManifest() {
  return {
    version: 1,
    jobId: 'source-job',
    sourceTranscript: {
      version: 1, source: { hash: 'complete-source-identity', duration: 30 }, language: 'en',
      speakers: [{ speakerId: 'speaker-1', providerId: 'voice-1', gender: 'male' }],
      utterances: [{ segmentId: 'segment-1', speakerId: 'speaker-1', sourceStart: 2.5, sourceEnd: 4.75,
        sourceText: 'Original speech in the complete source.', gender: 'male', confidence: 0.95,
        translatedText: 'This generated translation must not supply motion evidence.', dubStart: 90, dubEnd: 92 }],
      audioEvents: []
    },
    subtitles: { source_tr: [{ start: 2.5, end: 4.75, text: 'Kaynak konuşma altyazısı' }], dub_tr: [] },
    assets: {}
  };
}

function fixture({ motion = true, subtitles = false, dubbing = false, remote = true,
  prepare, extract, start, load, save, visual = false, session: suppliedSession } = {}) {
  const completeFile = new Blob(['complete cached source video'], { type: 'video/mp4' });
  completeFile.name = 'cached-source.mp4';
  const session = suppliedSession || { file: null, sourceTranscript: null, mediaManifest: null, storyboard: null };
  const state = { analysisSession: session, sourceTranscript: null, sourceContext: null, savedGameReady: false,
    gameState: 'ANALYZING', analysis: { prior: 'analysis' }, selectedRemoteVideo: remote ? { pageUrl: 'https://source.example/video' } : null };
  const els = new Proxy({}, { get(target, key) { return target[key] ||= new Element(); } });
  els.motionMode.checked = motion;
  els.subtitleMode.checked = subtitles;
  els.dubMode.checked = dubbing;
  const calls = { prepare: [], extract: [], start: [], load: [], save: [], events: [], visual: [], renders: 0 };
  const scope = vm.createContext({
    analysisProgress: createAnalysisProgress({ setTimer: () => 1, clearTimer() {} }),
    analysisOwner: new AbortController(), analysisAbortController: null, analysisSucceeded: false,
    framesProgress() {}, onTurkishMediaStatus() {},
    state, els, sourceContextAdapter, Blob, FormData, AbortSignal,
    console: { error() {} }, videoUrlInput: new Element(), resolveUrlBtn: new Element(),
    renderDebug() {}, updateAnalyzeAvailability() {},
    adaptiveAnalysisChunkPlan: () => ({ chunkCount: 1, chunks: [{ firstSheet: 0, sheetCount: 1 }] }),
    normalizeStoryContext: () => ({}), mergeStoryContexts: () => ({}),
    geminiRequestHeaders: () => ({}),
    analysisCheckpointKey: async () => null,
    analysisResponseCache: { readCheckpoint: async () => null, saveCheckpoint: async () => true },
    fetch: async (url, options) => {
      calls.visual.push({ url, options });
      if (visual) throw new DOMException('First request captured', 'AbortError');
      return { ok: true };
    },
    prepareStoryboardSource: async (selectedSession, file) => {
      calls.prepare.push({ session: selectedSession, file });
      const result = prepare ? await prepare(selectedSession, file) : completeFile;
      selectedSession.file = result;
      return result;
    },
    extractStoryboard: (...args) => {
      calls.extract.push(args);
      return extract ? extract(...args) : Promise.resolve({ frames: ['source frame'], timestamps: [0], duration: 30 });
    },
    mediaClient: {
      start: async (file, options) => {
        calls.start.push({ file, options: copy(options) });
        return start ? start(file, options) : sourceManifest();
      },
      loadResult: (manifest, settings) => {
        calls.load.push({ manifest, settings: copy(settings) });
        return load ? load(manifest, settings) : manifest;
      }
    },
    savedGames: { saveCurrent: async forced => {
      calls.save.push(forced);
      return save ? save(forced) : undefined;
    } },
    setGameState: value => { state.gameState = value; },
    renderMediaControls: () => { calls.renders += 1; },
    logEngineEvent: (type, data) => calls.events.push({ type, data: copy(data) })
  });
  scope.analysisAbortController = scope.analysisOwner;
  scope.postAnalysisForm = (url, body, options) => scope.fetch(url, { method: 'POST', body, headers: options.headers });
  // The optional continuation executes the real storyboard request setup,
  // then returns at the first fetch before unrelated response handling starts.
  const continuation = visual ? `${visualRequest}
try {
  await analyzeChunk(0, { protagonistProfile, storyContextMemory });
} catch (error) {
  if (error?.name !== 'AbortError' || error.message !== 'First request captured') throw error;
}
return { file, fastStoryboardPreparation };` : '';
  vm.runInContext(`${updateTranscript}\n${selectedModes}\nasync function runBranch(file, session, modes) {\nconst requestedProtagonist = '';\nlet analysisModeKey = '';\n${branch}\n${continuation}\nreturn { file, fastStoryboardPreparation };\n}`, scope);
  vm.runInContext(`async function runHandler(file, session, modes) {\ntry {\nawait runBranch(file, session, modes);\n${handlerFailure}\n}`, scope);
  return { scope, state, els, session, calls, completeFile,
    run: file => scope.runBranch(file ?? null, session, scope.selectedAnalysisModes()),
    runHandler: file => scope.runHandler(file ?? null, session, scope.selectedAnalysisModes()) };
}

test('the complete cached source is prepared before frame extraction and upload, while frame work overlaps the pending media job', async () => {
  const prepared = deferred();
  const frames = deferred();
  const mediaReady = deferred();
  const f = fixture({ prepare: () => prepared.promise, extract: () => frames.promise, start: () => mediaReady.promise });
  let finished = false;
  const running = f.run();
  running.then(() => { finished = true; });
  await tick();
  assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.calls.extract.length, 0, 'frame extraction cannot use an incomplete URL source');
  assert.equal(f.calls.start.length, 0, 'backend upload cannot use an incomplete URL source');
  prepared.resolve(f.completeFile);
  await tick();
  assert.equal(f.calls.extract.length, 1);
  assert.equal(f.calls.extract[0][0], f.completeFile);
  assert.equal(f.calls.extract[0][3].remoteSampling, true);
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.start[0].file, f.completeFile);
  assert.equal(f.session.audioContextStatus, 'pending');
  const preparedFrames = { frames: ['already prepared frame'], timestamps: [0] };
  frames.resolve(preparedFrames);
  await tick();
  assert.equal(finished, false, 'source speech is still pending while independent frame preparation finishes');
  assert.equal(f.state.sourceContext, null);
  mediaReady.resolve(sourceManifest());
  const result = await running;
  assert.equal(result.file, f.completeFile);
  assert.equal(await result.fastStoryboardPreparation, preparedFrames);
  assert.equal(f.session.audioContextStatus, 'ready');
});

test('motion-only analysis requests the source transcript with quality defaults and consumes canonical original speech', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.calls.start.length, 1);
  assert.deepEqual(f.calls.start[0].options, {
    outputs: { dub: false, subtitles: false, transcriptOnly: true }, qualityMode: 'quality', sceneContext: []
  });
  assert.equal(f.session.sourceTranscript, f.state.sourceTranscript);
  assert.equal(f.session.audioContextStatus, 'ready');
  const segment = f.state.sourceContext.segments[0];
  assert.equal(segment.originalText, 'Original speech in the complete source.');
  assert.equal(segment.text, segment.originalText);
  assert.equal(segment.startTime, 2.5);
  assert.equal(segment.endTime, 4.75);
  assert.equal(segment.textTr, '');
  assert.equal(segment.turkishText, '');
  assert.doesNotMatch(JSON.stringify(f.state.sourceContext), /generated translation|dubStart|dubEnd/);
  assert.equal(f.calls.save.length, 0, 'motion gameplay is saved by its later analysis stage');
});

test('a matching cached media manifest restores the client without uploading the source again', async () => {
  const cached = sourceManifest();
  const session = { sourceTranscript: cached.sourceTranscript, mediaManifest: cached,
    mediaModeKey: JSON.stringify({ dub: false, subtitles: false, quality: 'quality' }),
    storyboard: { frames: ['retained frame'] } };
  const f = fixture({ session });
  await f.run();
  assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.extract.length, 0);
  assert.equal(f.calls.load.length, 1);
  assert.equal(f.calls.load[0].manifest, cached);
  assert.deepEqual(f.calls.load[0].settings, { dubEnabled: false, subtitleTrack: 'off' });
  assert.equal(f.session.mediaManifest, cached);
  assert.equal(f.session.audioContextStatus, 'ready');
});

test('subtitle-only analysis skips frame extraction and awaits the saved-game write after becoming playable', async () => {
  const saving = deferred();
  const f = fixture({ motion: false, subtitles: true, save: () => saving.promise,
    extract: () => assert.fail('subtitle-only mode must not extract source frames') });
  let finished = false;
  const running = f.run();
  running.then(() => { finished = true; });
  await tick();
  assert.deepEqual(f.calls.start[0].options.outputs, { dub: false, subtitles: true, transcriptOnly: false });
  assert.equal(f.calls.extract.length, 0);
  assert.equal(f.state.analysis, null);
  assert.ok(['MEDIA_READY', 'DIALOGUE_READY'].includes(f.state.gameState));
  assert.equal(f.els.analysisState.textContent, f.state.gameState);
  assert.equal(f.els.playerSection.classes.has('hidden'), false);
  assert.equal(f.state.savedGameReady, true);
  assert.match(f.els.analysisOutput.textContent, /1 kaynak konuşma bölümü ve 1 konuşmacı/);
  assert.deepEqual(f.calls.save, [true]);
  assert.equal(finished, false, 'analysis waits for the asynchronous saved-game write');
  saving.resolve();
  await running;
  assert.equal(finished, true);
});

test('requested subtitles fail explicitly when source transcription fails and cannot manufacture speech or a ready game', async () => {
  const failedJob = new Error('Backend source transcription failed');
  const preparedFrames = { frames: ['retained visual source frame'], timestamps: [0] };
  const f = fixture({ subtitles: true, start: async () => { throw failedJob; }, extract: () => Promise.resolve(preparedFrames) });
  await assert.rejects(f.run(), error => error === failedJob);
  assert.equal(f.session.mediaManifest, null);
  assert.equal(f.session.audioContextStatus, 'unavailable');
  assert.equal(f.state.sourceTranscript, null);
  assert.equal(f.state.sourceContext, null);
  assert.equal(f.session.sourceTranscript, null);
  assert.equal(f.state.savedGameReady, false);
  assert.equal(f.state.gameState, 'ANALYZING');
  assert.equal(f.calls.renders, 0);
  assert.equal(f.calls.save.length, 0);
  assert.equal(f.session.storyboard, preparedFrames, 'independent source frames remain available for a retry');
  assert.deepEqual(f.calls.events, [{ type: 'SOURCE_TRANSCRIPT_UNAVAILABLE', data: { message: failedJob.message } }]);
});

test('motion-only analysis continues to the real visual request with prepared source frames and no speech evidence after a media failure', async () => {
  const failedJob = new Error('Source audio is silent or the media provider is unavailable');
  const sheet = new Blob(['verified source frame sheet'], { type: 'image/jpeg' });
  const storyboard = { sheets: [sheet], timestamps: [0, 15], duration: 30, totalBytes: sheet.size };
  const f = fixture({ visual: true, start: async () => { throw failedJob; }, extract: () => Promise.resolve(storyboard) });
  // A reused session must not carry its earlier speech into this visual run.
  f.state.sourceTranscript = sourceManifest().sourceTranscript;
  f.state.sourceContext = sourceContextAdapter(f.state.sourceTranscript);
  f.session.sourceTranscript = f.state.sourceTranscript;
  await f.run();
  assert.equal(f.calls.extract.length, 1);
  assert.equal(f.session.storyboard, storyboard);
  assert.equal(f.calls.visual.length, 1, 'the actual source storyboard analysis request still runs');
  const request = f.calls.visual[0];
  assert.equal(request.url, '/api/gemini-storyboard-analyze');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.getAll('storyboards').length, 1);
  assert.equal(await request.options.body.get('storyboards').text(), await sheet.text());
  assert.equal(request.options.body.get('duration'), '30');
  assert.equal(request.options.body.get('dialogueContext'), '[]');
  assert.equal(request.options.body.get('dialogueSpeakerContext'), '[]');
  assert.equal(request.options.body.get('sensoryAudioContext'), '[]');
  assert.equal(f.state.sourceTranscript, null);
  assert.equal(f.state.sourceContext, null);
  assert.equal(f.session.sourceTranscript, null);
  assert.equal(f.session.mediaManifest, null);
  assert.equal(f.session.audioContextStatus, 'unavailable');
  assert.equal(f.state.savedGameReady, false);
  assert.equal(f.calls.save.length, 0);
  assert.equal(f.calls.start.length, 1, 'no alternate speech request is attempted');
  assert.deepEqual(f.calls.events, [{ type: 'SOURCE_TRANSCRIPT_UNAVAILABLE', data: { message: failedJob.message } }]);
});

test('requested dubbing remains strict and prevents visual provider work after a source media failure', async () => {
  const failedJob = new Error('Turkish dubbing failed');
  const storyboard = { sheets: [new Blob(['source frames'])], timestamps: [0], duration: 30, totalBytes: 13 };
  const f = fixture({ visual: true, dubbing: true, start: async () => { throw failedJob; },
    extract: () => Promise.resolve(storyboard) });
  await assert.rejects(f.run(), error => error === failedJob);
  assert.equal(f.calls.visual.length, 0);
  assert.equal(f.session.storyboard, storyboard);
  assert.equal(f.session.audioContextStatus, 'unavailable');
  assert.equal(f.state.sourceContext, null);
  assert.equal(f.state.savedGameReady, false);
  assert.equal(f.calls.save.length, 0);
});

test('motion-only cancellation rejects instead of continuing visually and the analysis handler returns CANCELLED and IDLE', async () => {
  const cancelled = new DOMException('Media job cancelled by the user', 'AbortError');
  const storyboard = { sheets: [new Blob(['source frames'])], timestamps: [0], duration: 30, totalBytes: 13 };
  const f = fixture({ visual: true, start: async () => { throw cancelled; }, extract: () => Promise.resolve(storyboard) });
  await assert.rejects(f.run(), error => error === cancelled);
  assert.equal(f.calls.visual.length, 0, 'cancelling source transcription must not start a storyboard POST');
  f.state.analysisInProgress = true;
  f.els.videoInput.disabled = true;
  await f.runHandler();
  assert.equal(f.calls.visual.length, 0);
  assert.equal(f.els.analysisState.textContent, 'CANCELLED');
  assert.equal(f.state.gameState, 'IDLE');
  assert.equal(f.state.analysisInProgress, false);
  assert.equal(f.els.videoInput.disabled, false);
  assert.equal(f.state.savedGameReady, false);
  assert.equal(f.calls.save.length, 0);
});
