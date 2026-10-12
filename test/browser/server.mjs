import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve('public');
mkdirSync('work/browser', { recursive: true });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc2=size=320x180:rate=24:duration=24', '-c:v', 'libvpx', '-b:v', '200k', '-an', 'work/browser/synthetic.webm']);
const hook = `
globalThis.__gameplayTest = {
  async load(analysis, snapshot = null) {
    clearPreviousGameResidue();
    const response = await fetch('/synthetic.webm');
    const file = new File([await response.blob()], 'synthetic.webm', { type: 'video/webm' });
    state.selectedFile = file; state.savedGameReady = true; state.analysis = analysis;
    state.videoObjectUrl = URL.createObjectURL(file); els.video.src = state.videoObjectUrl;
    els.video.load(); initializeInteractive(analysis, snapshot);
    await new Promise(resolve => els.video.readyState >= 2 ? resolve() : els.video.addEventListener('loadeddata', resolve, { once: true }));
  },
  snapshot: () => state.gameplayPlayer.capture(),
  state: () => ({ ...state.gameplayPlayer.getState(), graph: undefined }),
  restore: snapshot => initializeInteractive(state.analysis, snapshot),
  capture: () => captureSavedGame(),
  async saveAndLoad() { const saved = await captureSavedGame(); return saved.payload.gameplay; }
};`;
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, configured: false, capabilities: {}, revision: 'browser-fixture' }));
    }
    if (url.pathname === '/synthetic.webm') {
      res.setHeader('Content-Type', 'video/webm'); return res.end(readFileSync('work/browser/synthetic.webm'));
    }
    const filename = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    let body = readFileSync(filename);
    if (filename === path.join(root, 'app.js')) body = Buffer.concat([body, Buffer.from(hook)]);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(filename)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
server.listen(4174, '127.0.0.1');
