import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { planSourceTranscriptionWindows, transcribeSourceWindows, groundWindowResult,
  mergeGroundedSourceWindows, auditSourceTranscript } from '../lib/source-transcription-windows.js';
import { parseModelJson } from '../public/model-json.js';
import { requireDialogueTiming, repairDialogueTimestamps, filterValidDialogueRanges } from '../public/dialogue-integrity.js';

const line = (startTime = 1, endTime = 2, originalText = 'A brief reply.', speakerId = 'voice-a') => ({
  segmentId: 'line-1', startTime, endTime, originalText, turkishText: 'Kısa bir yanıt.', speakerId
});

test('source windows cover the complete known duration with bounded spans and short sources remain one asset', () => {
  for (const duration of [2, 90, 120]) assert.equal(planSourceTranscriptionWindows(duration).length, 1);
  const windows = planSourceTranscriptionWindows(3600);
  assert.equal(windows[0].startTime, 0);
  assert.equal(windows.at(-1).endTime, 3600);
  for (let i = 0; i < windows.length; i++) {
    assert.ok(windows[i].endTime - windows[i].startTime <= 90);
    if (i) assert.equal(windows[i - 1].endTime - windows[i].startTime, 6);
  }
  assert.throws(() => planSourceTranscriptionWindows(NaN), /DURATION_REQUIRED/);
  assert.throws(() => planSourceTranscriptionWindows(300, { windowSeconds: 300 }), /INVALID/);
});

test('invalid supplemental non-speech timing never discards valid dialogue from the same window', () => {
  const window = { id: 'window-001', index: 0, startTime: 0, endTime: 90 };
  const result = groundWindowResult({
    segments: [line(10, 12, 'Verified speech')],
    nonSpeechEvents: [
      { eventId: 'event-good', startTime: 20, endTime: 21, soundType: 'laugh' },
      { eventId: 'event-bad', startTime: 88, endTime: 94, soundType: 'breath' }
    ]
  }, window);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].originalText, 'Verified speech');
  assert.equal(result.nonSpeechEvents.length, 1);
  assert.equal(result.nonSpeechEvents[0].eventId, 'window-001:event-good');
  assert.equal(result.rejectedInvalidEventCount, 1);
  assert.match(result.warnings.at(-1), /non-speech event/);
});

test('zero-speech partial coverage retries only failed retained windows once before declaring no dialogue', async () => {
  const calls = [];
  let failedOnce = false;
  const result = await transcribeSourceWindows({
    duration: 180,
    state: {},
    prepareAsset: async window => ({ uri: window.id }),
    transcribeWindow: async (_asset, window) => {
      calls.push(window.id);
      if (window.index === 1 && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error('temporary timing failure'), { code: 'DIALOGUE_TIMING_INVALID' });
      }
      return { segments: window.index === 1 ? [line(2, 3, 'Recovered speech')] : [] };
    }
  });
  assert.equal(result.coverageAudit.complete, true);
  assert.equal(result.parsed.segments.length, 1);
  assert.equal(result.parsed.segments[0].originalText, 'Recovered speech');
  assert.deepEqual(calls, ['window-001', 'window-002', 'window-003', 'window-002']);
});

test('late source dialogue is grounded by its actual chunk offset, preserving stable chunk identifiers', async () => {
  const prepared = [];
  const state = {};
  const result = await transcribeSourceWindows({ duration: 260, state,
    prepareAsset: async window => { prepared.push(window.id); return { uri: `retained:${window.id}` }; },
    transcribeWindow: async (_asset, window) => ({ segments: [line(1, 2, `Reply in ${window.id}`)] })
  });
  assert.equal(prepared.length, 4);
  assert.equal(result.parsed.segments.at(-1).startTime, 253);
  assert.equal(result.parsed.segments.at(-1).endTime, 254);
  assert.equal(result.parsed.segments.at(-1).segmentId, 'window-004:line-1');
  assert.equal(result.coverageAudit.videoDuration, 260);
  assert.equal(result.coverageAudit.firstTranscriptTime, 1);
  assert.equal(result.coverageAudit.lastTranscriptTime, 254);
  assert.equal(result.coverageAudit.transcriptSpan, 253);
  assert.equal(result.coverageAudit.segmentCount, 4);
  assert.equal(result.coverageAudit.complete, true);
});

test('minority failed windows return usable partial coverage and later retry only the retained failure', async () => {
  const state = {}, prepared = [], requests = [];
  let fail = true, active = 0, peak = 0;
  const args = { duration: 250, state,
    prepareAsset: async window => { prepared.push(window.id); return { uri: `uploaded:${window.id}` }; },
    transcribeWindow: async (asset, window) => {
      active++; peak = Math.max(peak, active); requests.push(asset.uri);
      try {
        if (window.index === 1 && fail) throw Object.assign(new Error('Temporary provider error'), { code: 'PROVIDER_UNAVAILABLE' });
        return { segments: [line(1, 2, `Reply in ${window.id}`)] };
      } finally { active--; }
    }
  };
  const partial = await transcribeSourceWindows(args);
  assert.equal(partial.coverageAudit.complete, false);
  assert.equal(partial.coverageAudit.fatalCoverage, false);
  assert.equal(partial.coverageAudit.processedWindowCount, 2);
  assert.equal(partial.coverageAudit.failedWindows[0].id, 'window-002');
  assert.equal(partial.parsed.segments.length, 2);
  const earlier = state.windows[0].result;
  fail = false;
  const result = await transcribeSourceWindows(args);
  assert.equal(peak, 1, 'provider work and media preparation remain bounded');
  assert.equal(prepared.length, 3, 'no source or failed asset is uploaded again');
  assert.deepEqual(requests, ['uploaded:window-001', 'uploaded:window-002', 'uploaded:window-003', 'uploaded:window-002']);
  assert.equal(state.windows[0].result, earlier);
  assert.equal(result.coverageAudit.processedWindowCount, 3);
  assert.equal(result.coverageAudit.failedWindows.length, 0);
  assert.equal(result.coverageAudit.retainedSuccessfulWindows, 2);
  assert.equal(result.parsed.segments.length, 3);
  await transcribeSourceWindows(args);
  assert.equal(requests.length, 4, 'an already complete retained source has no provider work');
});

test('overlap observations unify a voice only with unique timed evidence and preserve later repetitions', () => {
  const plan = planSourceTranscriptionWindows(180);
  const windows = plan.map(window => ({ ...window, status: 'complete', result: groundWindowResult({ segments: [] }, window) }));
  windows[0].result = groundWindowResult({ segments: [line(85, 87, 'Repeat this.', 'local-a')] }, plan[0]);
  windows[1].result = groundWindowResult({ segments: [line(1, 3, 'Repeat this.', 'local-b'),
    { ...line(20, 22, 'Repeat this.', 'local-b'), segmentId: 'line-2' }] }, plan[1]);
  const result = mergeGroundedSourceWindows(windows);
  assert.equal(result.segments.length, 2);
  assert.equal(result.deduplicatedOverlapCount, 1);
  assert.equal(result.segments[0].speakerId, result.segments[1].speakerId);
  assert.equal(result.segments[1].startTime, 104);
  windows[0].result.segments.push({ ...windows[0].result.segments[0], speakerId: 'other-voice', segmentId: 'other' });
  const ambiguous = mergeGroundedSourceWindows(windows);
  assert.equal(ambiguous.segments.length, 4, 'simultaneous voices are not merged from text alone');
});

test('one invalid source window is isolated without manufacturing a plausible source interval', async () => {
  const state = {};
  const result = await transcribeSourceWindows({ duration: 180, state,
    prepareAsset: async window => ({ uri: window.id }),
    transcribeWindow: async (_asset, window) => ({ segments: [window.index === 1 ? line(100, 102) : line()] })
  });
  assert.equal(result.coverageAudit.complete, false);
  assert.equal(result.coverageAudit.fatalCoverage, false);
  assert.equal(result.coverageAudit.failedWindows[0].reason, 'DIALOGUE_TIMING_INVALID');
  assert.equal(state.windows[1].result, undefined);
  assert.equal(result.parsed.segments.length, 2);
  assert.throws(() => groundWindowResult({ segments: [line(-1, 1)] }, { id: 'window-x', startTime: 100, endTime: 190 }), /TIMING_INVALID/);
});

test('uncovered intervals record uncertainty without assuming speech, silence, or invented replacement words', async () => {
  let rechecks = 0;
  const args = { duration: 180, prepareAsset: async window => ({ uri: window.id }),
    transcribeWindow: async () => ({ segments: [] }),
    recheckWindow: async () => { rechecks++; return { segments: [] }; }
  };
  const empty = await transcribeSourceWindows({ ...args, state: {} });
  assert.equal(empty.parsed.segments.length, 0);
  assert.equal(rechecks, 0);
  assert.deepEqual(empty.coverageAudit.uncoveredWindows, [{ startTime: 0, endTime: 180 }]);
  assert.match(empty.coverageAudit.uncoveredWindowMeaning, /not evidence/);
  await transcribeSourceWindows({ ...args, state: {}, speechEvidence: [
    { type: 'speech', sourceVerified: false, startTime: 10, endTime: 11 },
    { type: 'non-speech', sourceVerified: true, startTime: 10, endTime: 11 }
  ] });
  assert.equal(rechecks, 0);
  const checked = await transcribeSourceWindows({ ...args, state: {}, speechEvidence: [
    { type: 'speech', sourceVerified: true, startTime: 10, endTime: 11 }
  ] });
  assert.equal(rechecks, 1);
  assert.equal(checked.parsed.segments.length, 0);
});

test('audit separates transcription gaps from windows never successfully processed', () => {
  const audit = auditSourceTranscript({ duration: 180, windows: [
    { id: 'one', startTime: 0, endTime: 90, status: 'complete' },
    { id: 'two', startTime: 84, endTime: 174, status: 'failed' },
    { id: 'three', startTime: 168, endTime: 180, status: 'complete' }
  ] }, [line(20, 22)]);
  assert.deepEqual(audit.unprocessedWindows, [{ startTime: 90, endTime: 168 }]);
  assert.deepEqual(audit.uncoveredWindows, [{ startTime: 0, endTime: 20 }, { startTime: 22, endTime: 180 }]);
  assert.equal(audit.complete, false);
});

test('systemic provider quota failure aborts after the first window instead of becoming incomplete coverage', async () => {
  const calls = [];
  await assert.rejects(transcribeSourceWindows({
    duration: 928.94,
    state: {},
    prepareAsset: async window => ({ uri: window.id }),
    transcribeWindow: async (_asset, window) => {
      calls.push(window.id);
      throw Object.assign(new Error('429 RESOURCE_EXHAUSTED quota exceeded; Please retry in 49m'), {
        status: 429
      });
    }
  }), error => Number(error.status) === 429 && /RESOURCE_EXHAUSTED/.test(error.message));
  assert.deepEqual(calls, ['window-001']);
});

test('majority failed source windows remain fatal while minority failure is usable', async () => {
  await assert.rejects(transcribeSourceWindows({
    duration: 180, state: {},
    prepareAsset: async window => ({ uri: window.id }),
    transcribeWindow: async (_asset, window) => {
      if (window.index > 0) throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      return { segments: [line()] };
    }
  }), error => error.code === 'SOURCE_TRANSCRIPTION_INCOMPLETE' &&
    error.coverageAudit.fatalCoverage === true &&
    error.coverageAudit.completeWindows === 1 &&
    error.coverageAudit.failedWindowCount === 2);
});

test('invalid provider rows can be rejected without changing valid source timestamps', () => {
  const filtered = filterValidDialogueRanges([
    line(1, 2, 'valid one'),
    { ...line(3, 4, 'valid two'), segmentId: 'line-2' },
    { ...line(7, 6, 'bad reversed'), segmentId: 'bad-1' },
    { ...line(89, 95, 'bad overflow'), segmentId: 'bad-2' }
  ], 90);
  assert.equal(filtered.segments.length, 2);
  assert.equal(filtered.rejectedCount, 2);
  assert.deepEqual(filtered.segments.map(row => [row.startTime, row.endTime]), [[1, 2], [3, 4]]);
});

test('window provider JSON recovery retries on the same retained asset and shared parser', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function analyzeDialogueSourceAsset(');
  const end = source.indexOf("\napp.post(\n  '/api/gemini-dialogue-analyze'", start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const scope = vm.createContext({ parseModelJson, requireDialogueTiming, repairDialogueTimestamps, filterValidDialogueRanges,
    process: { env: {} }, console: { warn() {}, info() {} }, wait: async () => {},
    addGeminiUsage() {}, mapWithConcurrency: async (items, _n, worker) => Promise.all(items.map(worker)),
    transcribeDialogueGemini35: async () => { throw new Error('Unavailable in mock account'); },
    ai: { models: { generateContent: async request => {
      requests.push(request);
      return { text: requests.length < 3 ? '{"segments":[' : JSON.stringify({ segments: [line()] }) };
    } } },
    remoteFile: { uri: 'retained-window-asset', mimeType: 'audio/mpeg' }
  });
  vm.runInContext(source.slice(start, end), scope);
  const result = await vm.runInContext(`analyzeDialogueSourceAsset({ ai, remoteFile, req: { file: { mimetype: 'audio/mpeg' } },
    prompt: 'Listen to this complete audio window.', duration: 90, dialogueStage() {}, dialogueUsage: {} })`, scope);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.contents[0].parts[0].fileData.fileUri === 'retained-window-asset'));
  assert.equal(result.parsed.segments[0].originalText, 'A brief reply.');
});

test('an empty bounded dialogue window gets one careful speech recheck before being accepted as silent', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function analyzeDialogueSourceAsset(');
  const end = source.indexOf("\napp.post(\n  '/api/gemini-dialogue-analyze'", start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const scope = vm.createContext({ parseModelJson, requireDialogueTiming, repairDialogueTimestamps,
    filterValidDialogueRanges,
    process: { env: {} }, console: { warn() {}, info() {} }, wait: async () => {},
    addGeminiUsage() {}, mapWithConcurrency: async (items, _n, worker) => Promise.all(items.map(worker)),
    transcribeDialogueGemini35: async () => { throw new Error('Unavailable in mock account'); },
    ai: { models: { generateContent: async request => {
      requests.push(request);
      return { text: requests.length === 1
        ? JSON.stringify({ hasDialogue: false, segments: [] })
        : JSON.stringify({ hasDialogue: true, segments: [line(12, 13, 'quiet reply')] }) };
    } } },
    remoteFile: { uri: 'retained-window-asset', mimeType: 'audio/mpeg' }
  });
  vm.runInContext(source.slice(start, end), scope);
  const result = await vm.runInContext(`analyzeDialogueSourceAsset({
    ai, remoteFile, req: { file: { mimetype: 'audio/mpeg' } },
    prompt: 'Listen to this bounded audio window.', duration: 90,
    timingScope: 'window', allowPartialInvalidRanges: true,
    dialogueStage() {}, dialogueUsage: {}
  })`, scope);
  assert.equal(requests.length, 2);
  assert.equal(result.parsed.segments.length, 1);
  assert.equal(result.parsed.segments[0].originalText, 'quiet reply');
  assert.match(requests[1].contents[0].parts.at(-1).text, /final careful listening pass/);
});

test('window dialogue keeps valid rows after bounded retries when only some timestamps remain invalid', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function analyzeDialogueSourceAsset(');
  const end = source.indexOf("\napp.post(\n  '/api/gemini-dialogue-analyze'", start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const validRows = Array.from({ length: 11 }, (_, index) => ({
    ...line(index + 1, index + 1.5, `valid-${index + 1}`),
    segmentId: `valid-${index + 1}`
  }));
  const invalidRows = [
    { ...line(92, 94, 'overflow-1'), segmentId: 'bad-1' },
    { ...line(10, 9, 'reversed'), segmentId: 'bad-2' },
    { ...line(-1, 1, 'negative'), segmentId: 'bad-3' }
  ];
  const scope = vm.createContext({ parseModelJson, requireDialogueTiming, repairDialogueTimestamps,
    filterValidDialogueRanges,
    process: { env: {} }, console: { warn() {}, info() {} }, wait: async () => {},
    addGeminiUsage() {}, mapWithConcurrency: async (items, _n, worker) => Promise.all(items.map(worker)),
    transcribeDialogueGemini35: async () => { throw new Error('Unavailable in mock account'); },
    ai: { models: { generateContent: async request => {
      requests.push(request);
      return { text: JSON.stringify({ segments: [...validRows, ...invalidRows] }) };
    } } },
    remoteFile: { uri: 'retained-window-asset', mimeType: 'audio/mpeg' }
  });
  vm.runInContext(source.slice(start, end), scope);
  const result = await vm.runInContext(`analyzeDialogueSourceAsset({
    ai, remoteFile, req: { file: { mimetype: 'audio/mpeg' } },
    prompt: 'Listen to this complete audio window.', duration: 90,
    timingScope: 'window', allowPartialInvalidRanges: true,
    dialogueStage() {}, dialogueUsage: {}
  })`, scope);
  assert.equal(requests.length, 3, 'invalid timing receives bounded model retries before safe row filtering');
  assert.equal(result.parsed.segments.length, 11);
  assert.equal(result.parsed.rejectedInvalidSegmentCount, 3);
  assert.equal(JSON.stringify(result.parsed.segments.map(row => row.segmentId)),
    JSON.stringify(validRows.map(row => row.segmentId)));
  const retryPrompt = requests.at(-1).contents[0].parts.at(-1).text;
  assert.match(retryPrompt, /RELATIVE to this audio asset/);
  assert.match(retryPrompt, /0 <= startTime < endTime <= 90\.000/);
  assert.doesNotMatch(retryPrompt, /absolute seconds/);
});

test('server retained phone audio recovers a failed window without another device upload, extraction, or successful-window request', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('async function analyzeDialogueSourceAsset(');
  const routeStart = source.indexOf("app.post(\n  '/api/gemini-dialogue-analyze'", helperStart);
  const routeEnd = source.indexOf('\n);', routeStart) + 3;
  for (const inlineFallback of [false, true]) {
  const session = { filePath: '/retained-phone-audio', fileName: 'source.mp3', mimeType: 'audio/mpeg',
    receivedSize: 100, totalSize: 100, activeWrites: 0 };
  const sessions = new Map([['phone-upload', session]]);
  const uploaded = [], modelUris = [], extractions = [];
  let route, failing = true;
  const ai = { files: {
    upload: async ({ file }) => {
      uploaded.push(file);
      if (inlineFallback) throw Object.assign(new Error('Files API unavailable'), { status: 404 });
      return { uri: `provider:${file}`, name: `files/${uploaded.length}`, state: 'ACTIVE', mimeType: 'audio/mpeg' };
    }, delete: async () => {}
  }, models: { generateContent: async request => {
    const media = request.contents[0].parts[0];
    const uri = media.fileData?.fileUri || Buffer.from(media.inlineData.data, 'base64').toString();
    modelUris.push(uri);
    return { text: failing && uri.includes('window-002') ? '{"segments":[' :
      JSON.stringify({ segments: [line(1, 2, `Reply from ${uri}`)] }) };
  } } };
  const scope = vm.createContext({ parseModelJson, requireDialogueTiming, repairDialogueTimestamps, filterValidDialogueRanges,
    normalizeDialogueSegments: rows => rows, transcribeSourceWindows, auditSourceTranscript,
    process: { env: {} }, console: { warn() {}, info() {}, error() {} }, wait: async () => {},
    fs: { existsSync: () => false, promises: { unlink: async () => {},
      readFile: async file => Buffer.from(`provider:${file}`) } }, ffmpegPath: '/ffmpeg',
    prepareDialogueAudioWindow: async (_file, window) => {
      extractions.push(window.startTime);
      return { path: `/window-${String(extractions.length).padStart(3, '0')}.mp3`, size: 100, mimetype: 'audio/mpeg' };
    }, probeLocalAudioDuration: async () => 250,
    prepareLocalDialogueAudio: () => assert.fail('retained phone audio is already prepared'),
    addGeminiUsage() {}, emptyGeminiUsage: () => ({ requests: 0 }),
    mapWithConcurrency: async (items, _n, worker) => Promise.all(items.map(worker)),
    transcribeDialogueGemini35: async () => { throw new Error('Unavailable in mock account'); },
    dialogueUploadSessions: sessions, dialogueUpload: { single: () => () => {} },
    resolveGeminiApiKey: () => 'opaque-test-key', GoogleGenAI: function () { return ai; },
    AbortController, dialogueLastSuccessAt: 0, dialogueQuotaBlockedUntil: 0,
    app: { post: (_path, _upload, handler) => { route = handler; } }
  });
  vm.runInContext(source.slice(helperStart, routeEnd), scope);
  const response = () => ({ statusCode: 200, writableEnded: false,
    once() {}, removeListener() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.writableEnded = true; return this; } });
  const req = () => ({ body: { uploadId: 'phone-upload', duration: '250' } });
  const partial = response();
  await route(req(), partial);
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.body.available, true);
  assert.equal(partial.body.coverageAudit.complete, false);
  assert.equal(partial.body.coverageAudit.fatalCoverage, false);
  assert.equal(partial.body.coverageAudit.processedWindowCount, 2);
  assert.equal(partial.body.uploadId, 'phone-upload');
  assert.equal(partial.body.segments.length, 2);
  assert.equal(modelUris.length, 5, 'one successful request per complete window and three bounded JSON attempts on the failed window');
  assert.equal(uploaded.length, 3);
  if (inlineFallback) {
    assert.equal(session.transcriptionState.windows[1].asset.inlineAudioPart, undefined, 'failed inline audio stays on disk, not in accumulated base64 buffers');
    assert.equal(session.transcriptionState.windows[1].asset.inlineAudioPath, '/window-002.mp3');
  }
  failing = false;
  const recovered = response();
  await route(req(), recovered);
  assert.equal(recovered.body.available, true);
  assert.equal(recovered.body.coverageAudit.processedWindowCount, 3);
  assert.equal(recovered.body.segments.at(-1).startTime, 169);
  assert.equal(modelUris.length, 6);
  assert.equal(modelUris[5], modelUris[1], 'retry retains the failed provider file URI');
  assert.equal(uploaded.length, 3);
  assert.equal(extractions.length, 3);
  const cached = response();
  await route(req(), cached);
  assert.equal(cached.body, recovered.body);
  assert.equal(modelUris.length, 6);
  assert.ok(session.transcriptionState.windows.every(window => !window.asset), 'completed windows retain transcript results and release their provider/inline assets');
  }
});
