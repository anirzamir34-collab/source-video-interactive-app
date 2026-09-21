import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';

const ffmpeg = fs.existsSync(ffmpegStatic || '') ? ffmpegStatic : '/usr/bin/ffmpeg';
const ffprobe = '/usr/bin/ffprobe';

test('DASH proxy produces a real playable MP4 containing both picture and sound', {
  skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe), timeout: 15000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-dash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-map', '0:v', '-map', '1:v', '-map', '2:a',
    '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1',
    '-c:a', 'aac', '-f', 'dash', path.join(dir, 'manifest.mpd')], { timeout: 8000 });
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const from = source.indexOf("app.get('/api/video-proxy'");
  const code = source.slice(from, source.indexOf('\n\nconst dialogueUpload', from));
  let handler;
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === '/proxy') {
      req.query = { token: 'dash' };
      res.status = value => { res.statusCode = value; return res; };
      res.json = value => res.end(JSON.stringify(value));
      handler(req, res);
      return;
    }
    const file = path.join(dir, path.basename(req.url === '/manifest' ? '/manifest.mpd' : req.url));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  sessions.set('dash', { type: 'dash', sourceUrl: `${base}/manifest`, referer: base, expiresAt: Date.now() + 60000 });
  vm.runInNewContext(code, {
    app: { get: (_url, fn) => { handler = fn; } },
    URL, AbortController, Readable, pipeline, setTimeout, clearTimeout, console,
    ffmpegPath: ffmpeg, spawn, resolvedVideoSessions: sessions,
    // The test fixture alone permits its local media server. Production keeps
    // validatePublicUrl, which is tested separately against private addresses.
    validatePublicUrl: async url => new URL(url)
  });
  const response = await fetch(`${base}/proxy`, { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  const output = path.join(dir, 'output.mp4');
  fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
  const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], { timeout: 3000 }));
  assert.deepEqual(metadata.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').width, 320);
  assert.ok(Number(metadata.streams.find(stream => stream.codec_type === 'video').duration) >= 1.4);
});
