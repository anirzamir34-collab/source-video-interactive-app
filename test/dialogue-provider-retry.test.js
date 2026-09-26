import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the existing provider loop against simulated HTTP failures, retaining
// the already uploaded media URI. No external API requests are made.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('      let parsed = null;', source.indexOf('const transcriptGrounding'));
const end = source.indexOf('      // If multimodal enrichment', start);
assert.ok(start >= 0 && end > start);
const loop = source.slice(start, end);

async function run(errors) {
  const requests = [];
  const delays = [];
  const scope = vm.createContext({
    process: { env: {} }, remoteFile: { uri: 'already-uploaded-audio', mimeType: 'audio/wav' },
    req: { file: { mimetype: 'audio/wav' } }, prompt: 'Analyze speech', transcriptGrounding: '',
    dialogueUsage: {}, addGeminiUsage() {}, console: { warn() {} },
    dialogueStage() {},
    wait: async delay => { delays.push(delay); },
    ai: { models: { generateContent: async request => {
      requests.push(request);
      const error = errors[requests.length - 1];
      if (error) throw error;
      return { text: JSON.stringify({ segments: [{ originalText: 'Hello' }] }) };
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
