// Fetch the current standalone yt-dlp build at install time. Unlike the
// Python zipapp shipped by youtube-dl-exec, it bundles curl_cffi, so it can
// impersonate a real browser on Cloudflare-protected video sites. Each deploy
// also picks up the newest site extractors. Failure is never fatal: the
// packaged extractor stays available as the fallback.
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../vendor/yt-dlp', import.meta.url));
const asset = process.platform === 'linux' && process.arch === 'x64' ? 'yt-dlp_linux'
  : process.platform === 'linux' && process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : '';

if (!asset || process.env.SKIP_YT_DLP_DOWNLOAD) {
  console.log('Standalone yt-dlp skipped; packaged extractor will be used.');
} else {
  const partial = `${target}.download`;
  try {
    await mkdir(fileURLToPath(new URL('../vendor/', import.meta.url)), { recursive: true });
    const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
      { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if ((await stat(partial)).size < 5 * 1024 * 1024) throw new Error('download too small');
    await chmod(partial, 0o755);
    await rename(partial, target);
    console.log('Standalone yt-dlp with browser impersonation installed.');
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    console.warn(`Standalone yt-dlp unavailable (${error.message}); packaged extractor will be used.`);
  }
}
