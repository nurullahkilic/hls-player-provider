import terser from '@rollup/plugin-terser';

const input = 'src/index.js';
const name  = 'HLS'; // window.HLS.HLSPlayer, window.HLS.parseM3U8, …

/** @type {import('rollup').RollupOptions[]} */
export default [
  // ── ESM — for bundlers (Vite, Webpack, Rollup) ────────────────────────────
  {
    input,
    output: {
      file:      'dist/hls-player.esm.js',
      format:    'esm',
      sourcemap: true,
    },
  },

  // ── CJS — for Node / CommonJS require() ───────────────────────────────────
  {
    input,
    output: {
      file:      'dist/hls-player.cjs.js',
      format:    'cjs',
      exports:   'named',
      sourcemap: true,
    },
  },

  // ── UMD (unminified) — for local dev / debugging ──────────────────────────
  {
    input,
    output: {
      file:      'dist/hls-player.js',
      format:    'umd',
      name,
      exports:   'named',
      sourcemap: true,
    },
  },

  // ── UMD (minified) — CDN / production <script> tag ───────────────────────
  {
    input,
    output: {
      file:      'dist/hls-player.min.js',
      format:    'umd',
      name,
      exports:   'named',
      sourcemap: true,
      plugins:   [terser()],
    },
  },
];
