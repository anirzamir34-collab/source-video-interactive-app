import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseModelJson } from '../public/model-json.js';
import { repairDialogueTimestamps, requireDialogueTiming, filterValidDialogueRanges } from '../public/dialogue-integrity.js';

// Run the existing provider loop against simulated HTTP failures, retaining
// the already uploaded media URI. No external API requests are made.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('      let parsed = null;', source.indexOf('const transcriptGrounding'));
const end = source.indexOf('      // If multimodal enrichment', start);
assert.ok(start >= 0 && end > start);
const loop = source.slice(start, end);

async function run(errors = [], responses = []) {
  const requests = [];
  const delays = [];
  const scope = vm.createContext({
    parseModelJson, repairDialogueTimestamps, requireDialogueTiming, filterValidDialogueRanges,
    timingScope: 'source', allowPartialInvalidRanges: false,
    duration: 900, process: { env: {} }, remoteFile: { uri: 'already-uploaded-audio', mimeType: 'audio/wav' },
    req: { file: { mimetype: 'audio/wav' } }, prompt: 'Analyze speech', transcriptGrounding: '',
    dialogueUsage: {}, addGeminiUsage() {}, console: { warn() {} },
    dialogueStage() {}, inlineAudioPart: null,
    wait: async delay => { delays.push(delay); },
    ai: { models: { generateContent: async request => {
      requests.push(request);
      const error = errors[requests.length - 1];
      if (error) throw error;
      if (responses[requests.length - 1] != null) return { text: responses[requests.length - 1] };
      return { text: JSON.stringify({ segments: [{ originalText: 'Hello', startTime: 1, endTime: 2, speakerId: 'a' }] }) };
    } } }
  });
  const result = await vm.runInContext(`(async () => { ${loop}; return { parsed, lastDialogueError }; })()`, scope);
  return { ...result, requests, delays };
}

test('transient 500 errors retry against the same uploaded audio URI without downloading or uploading again', async () => {
  for (const error of [Object.assign(new Error('Internal error'), { status: 500 }),
    new Error('{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}')]) {
    const result = await run([error]);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.delays, [1400]);
    assert.ok(result.requests.every(request => request.contents[0].parts[0].fileData.fileUri === 'already-uploaded-audio'));
    assert.equal(result.parsed.segments[0].originalText, 'Hello');
  }
});

test('a Files API 404 uses bounded inline audio without uploading again', async () => {
  const start = source.indexOf("        dialogueStage('gemini-upload-start');");
  const end = source.indexOf('      const processingDeadline', start);
  assert.ok(start >= 0 && end > start);
  const upload = source.slice(start, end).replace(/^      }\s*$/m, '');
  const audio = Buffer.from('small encoded speech');
  const stages = [];
  const scope = vm.createContext({
    uploadSession: null, req: { file: { mimetype: 'audio/mpeg', originalname: 'speech.mp3' } }, tempPath: '/tmp/speech.mp3',
    uploadedFile: null, remoteFile: null, inlineAudioPart: null,
    fs: { promises: { stat: async () => ({ size: audio.length }), readFile: async () => audio } },
    dialogueStage: stage => stages.push(stage), console: { warn() {} },
    ai: { files: { upload: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); } } }
  });
  await vm.runInContext(`(async () => { ${upload}; return inlineAudioPart; })()`, scope).then(part => {
    assert.equal(part.inlineData.mimeType, 'audio/mpeg');
    assert.equal(part.inlineData.data, audio.toString('base64'));
  });
  assert.ok(stages.includes('gemini-inline-audio-ready'));

  const oversized = vm.createContext({
    uploadSession: null, req: { file: { mimetype: 'audio/mpeg', originalname: 'large.mp3' } },
    tempPath: '/tmp/large.mp3', uploadedFile: null, remoteFile: null, inlineAudioPart: null,
    fs: { promises: { stat: async () => ({ size: 15 * 1024 * 1024 }),
      readFile: async path => {
        assert.equal(path, '/tmp/large.mp3.dialogue.mp3');
        return audio;
      }, unlink: async () => {} } },
    ffmpegPath: '/ffmpeg', preparationController: new AbortController(),
    prepareLocalDialogueAudio: async (_file, options) => {
      assert.equal(options.audioInput, true);
      assert.equal(options.bitrate, '32k');
      return { path: '/tmp/large.mp3.dialogue.mp3', size: audio.length, mimetype: 'audio/mpeg' };
    },
    dialogueStage() {}, console: { warn() {} },
    ai: { files: { upload: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); } } }
  });
  const compressed = await vm.runInContext(`(async () => { ${upload}; return inlineAudioPart; })()`, oversized);
  assert.equal(compressed.inlineData.data, audio.toString('base64'));
});

test('repeated transient failure is bounded; quota and invalid-input errors are not retried', async () => {
  const error = Object.assign(new Error('Internal error'), { status: 500 });
  const repeated = await run([error, error, error]);
  assert.equal(repeated.requests.length, 3);
  assert.deepEqual(repeated.delays, [1400, 2800]);
  assert.equal(repeated.parsed, null);
  for (const status of [400, 401, 403, 429]) {
    const result = await run([Object.assign(new Error('Request failed'), { status })]);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.delays, []);
  }
});

test('malformed provider JSON retries three times using the already uploaded source', async () => {
  const broken = new SyntaxError('Expected double-quoted property name in JSON');
  const recovered = await run([broken, broken]);
  assert.equal(recovered.requests.length, 3);
  assert.equal(recovered.parsed.segments[0].originalText, 'Hello');
  assert.ok(recovered.requests.every(request => request.contents[0].parts[0].fileData.fileUri === 'already-uploaded-audio'));
  const exhausted = await run([broken, broken, broken]);
  assert.equal(exhausted.requests.length, 3);
  assert.equal(exhausted.parsed, null);
  assert.equal(exhausted.lastDialogueError.message, broken.message);
});

test('collapsed speech intervals are remeasured on the same uploaded audio before acceptance', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ segmentId: `line-${i}`, speakerId: 'a',
    startTime: 3.04, endTime: 3.44, originalText: `Reply ${i}`, turkishText: `Yanıt ${i}` }));
  const broken = JSON.stringify({ segments: rows });
  const grounded = JSON.stringify({ timestampUnit: 'seconds', segments: rows.map((row, i) => ({ ...row,
    startTime: 184 + i * 4, endTime: 186 + i * 4 })) });
  const result = await run([], [broken, broken, grounded]);
  assert.equal(result.requests.length, 3);
  assert.equal(result.parsed.segments[0].startTime, 184);
  assert.equal(result.parsed.segments.at(-1).startTime, 264);
  assert.ok(result.requests.every(request => request.contents[0].parts[0].fileData.fileUri === 'already-uploaded-audio'));
  assert.match(result.requests[1].contents[0].parts[1].text, /measure each turn separately/);
});
test('three collapsed responses fail explicitly instead of caching a falsely successful transcript', async () => {
  const broken = JSON.stringify({ segments: Array.from({ length: 21 }, (_, i) => ({
    segmentId: `line-${i}`, speakerId: 'a', startTime: 3.04, endTime: 3.44, originalText: `Reply ${i}` })) });
  const result = await run([], [broken, broken, broken]);
  assert.equal(result.requests.length, 3);
  assert.equal(result.parsed, null);
  assert.equal(result.lastDialogueError.code, 'DIALOGUE_TIMING_INVALID');
  assert.equal(result.lastDialogueError.timingIntegrity.segmentCount, 21);
});
