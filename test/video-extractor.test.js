import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runVideoExtractor } from '../lib/video-extractor.js';
import { videoErrorDetail, videoResolutionFailure } from '../lib/video-url.js';

const url = 'https://m.vkvideo.ru/video-1_2?list=ln-example';
const processFixture = script => (_binary, _args, options) => spawn(process.execPath, ['-e', script], options);

test('extractor executes a real process and reads JSON without shell interpolation', async () => {
  let received;
  const result = await runVideoExtractor(url, { dumpSingleJson: true }, {
    spawnProcess: (binary, args, options) => {
      received = { args, options };
      return processFixture('console.log(JSON.stringify({formats:[{url:"https://cdn.test/video.mp4"}]}))')(binary, args, options);
    }
  });
  assert.equal(result.formats.length, 1);
  assert.deepEqual(received.args.slice(-2), ['--', url]);
  assert.equal(received.options.shell, undefined);
});

test('silent timed-out processes retain a timeout error and are reaped', async () => {
  let child;
  await assert.rejects(runVideoExtractor(url, {}, {
    timeoutMs: 80,
    spawnProcess: (binary, args, options) => (child = processFixture('setInterval(()=>{},1000)')(binary, args, options))
  }), error => {
    assert.equal(videoResolutionFailure(videoErrorDetail(error)).reason, 'VIDEO_RESOLUTION_TIMEOUT');
    return true;
  });
  assert.equal(child.signalCode, 'SIGKILL');
});

test('HTTP 502 process errors retain upstream status instead of claiming no video', async () => {
  await assert.rejects(runVideoExtractor(url, {}, {
    spawnProcess: processFixture('console.error("ERROR: Unable to download JSON metadata: HTTP Error 502: Bad Gateway");process.exit(1)')
  }), error => {
    assert.equal(error.exitCode, 1);
    const failure = videoResolutionFailure(videoErrorDetail(error));
    assert.equal(failure.reason, 'VIDEO_SOURCE_TEMPORARY_ERROR');
    assert.equal(failure.retryable, true);
    return true;
  });
});

test('missing binary stays distinguishable from unsupported content', async () => {
  await assert.rejects(runVideoExtractor(url, {}, {
    spawnProcess: (_binary, args, options) => spawn('/nonexistent/videoquest-extractor', args, options)
  }), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(videoResolutionFailure(videoErrorDetail(error)).reason, 'VIDEO_EXTRACTOR_UNAVAILABLE');
    return true;
  });
});

test('oversized output terminates the process before unbounded buffering', async () => {
  await assert.rejects(runVideoExtractor(url, {}, {
    maxOutputBytes: 1024,
    spawnProcess: processFixture('process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)')
  }), /VIDEO_EXTRACTOR_OUTPUT_LIMIT/);
});

test('cancellation kills the child and does not leave its timer or listener running', async () => {
  const controller = new AbortController();
  let child;
  const pending = runVideoExtractor(url, {}, {
    signal: controller.signal,
    spawnProcess: (binary, args, options) => (child = processFixture('setInterval(()=>{},1000)')(binary, args, options))
  });
  controller.abort();
  await assert.rejects(pending, /VIDEO_RESOLUTION_CANCELLED/);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('invalid process JSON has a distinct runtime error', async () => {
  await assert.rejects(runVideoExtractor(url, {}, { spawnProcess: processFixture('console.log("not json")') }), /VIDEO_EXTRACTOR_INVALID_RESPONSE/);
});
