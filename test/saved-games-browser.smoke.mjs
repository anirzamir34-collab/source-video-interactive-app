// Optional real-browser regression: set PLAYWRIGHT_MODULE and CHROMIUM_PATH.
// Requires ffmpeg on PATH. No API keys or paid provider calls are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'videoquest-saved-browser-'));
const mediaPath = path.join(scratch, 'sample.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '6', '-c:v', 'libvpx', '-b:v', '150k', mediaPath]);
const fixtureHook = `
globalThis.__savedGameFixture = {
  async complete(sourceKind) {
    clearPreviousGameResidue();
    const blob = await (await fetch('/fixture.webm')).blob();
    const file = new File([blob], 'sample.webm', { type: 'video/webm' });
    state.selectedFile = file;
    state.selectedSourceKind = sourceKind;
    state.selectedRemoteVideo = sourceKind === 'url' ? { sourceUrl: 'https://expired.invalid/video', proxyUrl: '/expired' } : null;
    state.videoObjectUrl = URL.createObjectURL(file);
    const ready = new Promise(resolve => els.video.addEventListener('loadedmetadata', resolve, { once: true }));
    els.video.src = state.videoObjectUrl;
    await ready;
    state.analysis = normalizeAnalysis({ schemaVersion: ANALYSIS_SCHEMA_VERSION, videoDuration: els.video.duration,
      actions: [{ actionId: 'walk', label: 'Bahçede yürü', startTime: 0, endTime: 2, sourceVerified: true, confidence: 0.99 }] });
    initializeInteractive(state.analysis);
    state.savedGameReady = true;
    state.analysisInProgress = true;
    const saved = await savedGames.saveCurrent(true);
    state.analysisInProgress = false;
    updateAnalyzeAvailability();
    return saved;
  },
  snapshot() { return { id: state.activeSavedGameId, actions: state.analysis?.actions?.length, ready: state.savedGameReady, local: state.videoObjectUrl.startsWith('blob:'), savedOnly: state.savedPlaybackOnly }; }
};`;
const apiWrites = [];
const requests = [];
const server = createServer(async (req, res) => {
  try {
    requests.push(req.url);
    if (req.url.startsWith('/api/')) {
      if (req.method !== 'GET') apiWrites.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.includes('capabilities') ? {} : { connected: false, error: 'Local regression test' }));
      return;
    }
    if (req.url === '/fixture.webm') { res.setHeader('Content-Type', 'video/webm'); res.end(await fs.readFile(mediaPath)); return; }
    const fileName = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    if (fileName.includes('..')) { res.writeHead(403).end(); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    res.setHeader('Content-Type', types[path.extname(fileName)] || 'application/octet-stream');
    let content = await fs.readFile(path.join(publicRoot, fileName));
    if (fileName === 'app.js') content = Buffer.concat([content, Buffer.from(fixtureHook)]);
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(scratch, 'profile');
let context;
const errors = [];
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH, headless: true,
    args: ['--no-sandbox', '--disable-gpu'], viewport: { width: 390, height: 844 }, acceptDownloads: true
  });
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => Boolean(globalThis.__savedGameFixture));
  return page;
}
try {
  let page = await launch();
  assert.equal(await page.evaluate(() => __savedGameFixture.complete('url')), true);
  assert.equal(await page.locator('.saved-game').count(), 1);
  assert.equal(await page.evaluate(() => __savedGameFixture.complete('file')), true);
  assert.equal(await page.locator('.saved-game').count(), 2);
  assert.match(await page.locator('[data-games-status]').innerText(), /Kaydedildi/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SAVED_GAMES_SCREENSHOT) await page.locator('#savedGames').screenshot({ path: process.env.SAVED_GAMES_SCREENSHOT, animations: 'disabled' });
  // A complete browser restart, not merely a reload, must retain both records.
  await context.close();
  page = await launch();
  await page.locator('.saved-game').nth(1).waitFor();
  const beforeReplay = requests.length;
  const urlCard = page.locator('.saved-game').filter({ hasText: 'URL videosu' });
  await urlCard.getByRole('button', { name: 'Baştan oyna' }).click();
  await page.waitForFunction(() => __savedGameFixture.snapshot().savedOnly);
  const snapshot = await page.evaluate(() => __savedGameFixture.snapshot());
  assert.equal(snapshot.actions, 1);
  assert.equal(snapshot.local, true);
  assert.ok(snapshot.id);
  assert.equal(await page.locator('#video').evaluate(video => video.currentSrc.startsWith('blob:')), true);
  assert.equal(requests.slice(beforeReplay).some(item => /fixture|expired|analy|resolve|dialogue|dub/.test(item)), false);
  await page.locator('#choices button').first().click();
  await page.waitForFunction(() => document.querySelector('#video').currentTime > 0.25);
  await page.locator('#video').evaluate(video => video.pause());
  const downloadEvent = page.waitForEvent('download');
  await urlCard.getByRole('button', { name: 'Yedek indir' }).click();
  const downloaded = await downloadEvent;
  const backup = path.join(scratch, 'game.vqgame');
  await downloaded.saveAs(backup);
  page.once('dialog', dialog => dialog.dismiss());
  await urlCard.getByRole('button', { name: 'Sil', exact: true }).click();
  assert.equal(await page.locator('.saved-game').count(), 2);
  page.once('dialog', dialog => dialog.accept());
  await urlCard.getByRole('button', { name: 'Sil', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.saved-game').length === 1);
  await page.locator('[data-games-import]').setInputFiles(backup);
  await page.waitForFunction(() => document.querySelectorAll('.saved-game').length === 2);
  await page.locator('.saved-game').filter({ hasText: 'URL videosu' }).getByRole('button', { name: 'Baştan oyna' }).click();
  await page.waitForFunction(oldId => { const current = __savedGameFixture.snapshot(); return current.id && current.id !== oldId && current.savedOnly; }, snapshot.id);
  assert.deepEqual(apiWrites, []);
  assert.deepEqual(errors, []);
  console.log('PASS: URL/upload save, browser restart, local replay, backup/restore, delete confirmation, mobile width, zero paid API calls.');
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true });
}
