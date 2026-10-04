import { build } from 'esbuild';

await build({ entryPoints: ['public/source-audio-codec.js'], outfile: 'public/source-audio-codec.bundle.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'linked', external: ['node:worker_threads'] });
console.log('Local MP3 conversion module built.');
