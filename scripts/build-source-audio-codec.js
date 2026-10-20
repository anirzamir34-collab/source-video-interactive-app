import { build } from 'esbuild';

await build({ entryPoints: ['public/source-audio-codec.js'], outfile: 'public/source-audio-codec.bundle.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'linked', external: ['node:worker_threads'] });
await build({ entryPoints: ['public/video-proxy.js'], outfile: 'public/video-proxy.bundle.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'linked', external: ['node:worker_threads'] });
console.log('Local MP3 conversion and video analysis-copy modules built.');
