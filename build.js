// build.js — esbuild bundler for renderer
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const themes = ['classic', 'classic-dark', 'frame', 'frame-dark', 'nord', 'nord-dark'];
const themeEntries = Object.fromEntries(themes.map(t => [
  `themes/${t}`,
  path.join(__dirname, 'src', 'themes', `${t}.css.js`),
]));

const opts = {
  entryPoints: { renderer: path.join(__dirname, 'src', 'renderer.js'), ...themeEntries },
  outdir: path.join(__dirname, 'dist'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  // Vue (used by @mrsf/milkdown-mrsf) wants these compile-time flags
  // injected by the bundler for tree-shaking. Defaults: prod build,
  // no Options API, no devtools, no hydration mismatch detail strings.
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
  loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('esbuild watching…');
  } else {
    await esbuild.build(opts);
  }
})().catch(e => { console.error(e); process.exit(1); });
