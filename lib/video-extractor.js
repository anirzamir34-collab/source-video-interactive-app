import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import youtubedl from 'youtube-dl-exec';

const pluginDirectory = fileURLToPath(new URL('../extractor-plugins', import.meta.url));

// The package's JSON convenience wrapper drops message/code on spawn errors
// and on killed processes with empty stderr. Own the process lifecycle so a
// timeout or missing binary never becomes an unexplained "source hidden".
export function runVideoExtractor(url, flags, {
  signal, timeoutMs = 20000, maxOutputBytes = 16 * 1024 * 1024,
  spawnProcess = spawn
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let stopped;
    let size = 0;
    let stderr = '';
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const stop = reason => {
      if (settled || stopped) return;
      stopped = new Error(reason);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const abort = () => stop(signal?.reason?.name === 'TimeoutError' ? 'VIDEO_RESOLUTION_TIMEOUT' : 'VIDEO_RESOLUTION_CANCELLED');
    try {
      child = spawnProcess(youtubedl.constants.YOUTUBE_DL_PATH, ['--plugin-dirs', pluginDirectory, ...youtubedl.args(flags), '--', url], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > maxOutputBytes) { stop('VIDEO_EXTRACTOR_OUTPUT_LIMIT'); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.once('error', error => finish(Object.assign(new Error(
        ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? 'VIDEO_EXTRACTOR_UNAVAILABLE' : 'VIDEO_EXTRACTOR_PROCESS_FAILED'
      ), { code: error.code, cause: error })));
      child.once('close', (exitCode, signalCode) => {
        if (stopped) { finish(stopped); return; }
        if (exitCode !== 0) {
          finish(Object.assign(new Error('VIDEO_EXTRACTOR_PROCESS_FAILED'), { stderr, exitCode, signalCode }));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object') throw Error('invalid metadata');
          finish(null, result);
        } catch { finish(new Error('VIDEO_EXTRACTOR_INVALID_RESPONSE')); }
      });
      timer = setTimeout(() => stop('VIDEO_RESOLUTION_TIMEOUT'), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
