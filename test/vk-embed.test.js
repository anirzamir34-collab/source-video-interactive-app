import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const bundledExtractor = fileURLToPath(new URL('../node_modules/youtube-dl-exec/bin/yt-dlp', import.meta.url));
const available = existsSync(bundledExtractor);

test('VK external player fallback preserves native extraction and access errors', { skip: !available && 'yt-dlp binary is not installed' }, async () => {
  const { stderr } = await promisify(execFile)('python3', [fileURLToPath(new URL('./vk-embed.test.py', import.meta.url))], { timeout: 15000 });
  assert.match(stderr, /OK/);
});

test('installed extractor loads the shipped VK plugin', { skip: !available && 'yt-dlp binary is not installed' }, async () => {
  const root = new URL('../', import.meta.url);
  // An unsupported scheme initializes plugins without making a network request.
  const result = await promisify(execFile)(fileURLToPath(new URL('node_modules/youtube-dl-exec/bin/yt-dlp', root)), [
    '--plugin-dirs', fileURLToPath(new URL('extractor-plugins', root)), '--verbose', '--simulate', 'videoquest-invalid:'
  ], { timeout: 15000 }).catch(error => error);
  assert.ok(/Extractor Plugins:.*videoquest \(VKIE\)/.test(result.stderr));
});
