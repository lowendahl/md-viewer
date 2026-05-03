// dev.js — esbuild watch + electron auto-restart
// Ctrl-C cleanly kills both. Closing the electron window also exits dev.
const esbuild = require('esbuild');
const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron');

delete process.env.ELECTRON_RUN_AS_NODE;

const themes = ['classic', 'classic-dark', 'frame', 'frame-dark', 'nord', 'nord-dark'];
const themeEntries = Object.fromEntries(themes.map(t => [
  `themes/${t}`,
  path.join(__dirname, 'src', 'themes', `${t}.css.js`),
]));

let electronProc = null;
let restarting = false;
let shuttingDown = false;
let restartTimer = null;

function startElectron() {
  if (shuttingDown) return;
  console.log('[dev] launching electron…');
  electronProc = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, MDV_DEV: '1' },
  });
  electronProc.on('exit', (code, sig) => {
    const wasRestarting = restarting;
    electronProc = null;
    restarting = false;
    if (shuttingDown) return;
    if (wasRestarting) return; // expected — we'll relaunch
    console.log(`[dev] electron exited (code=${code} sig=${sig}). Shutting down dev.`);
    shutdown(0);
  });
}

function scheduleRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!electronProc) { startElectron(); return; }
    console.log('[dev] rebuild → restarting electron…');
    restarting = true;
    try { electronProc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (electronProc) { try { electronProc.kill('SIGKILL'); } catch (_) {} }
      startElectron();
    }, 400);
  }, 150);
}

const opts = {
  entryPoints: { renderer: path.join(__dirname, 'src', 'renderer.js'), ...themeEntries },
  outdir: path.join(__dirname, 'dist'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    'process.env.NODE_ENV': '"development"',
  },
  loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  logLevel: 'info',
  plugins: [{
    name: 'dev-restart',
    setup(build) {
      let first = true;
      build.onEnd(result => {
        if (result.errors && result.errors.length) {
          console.error(`[dev] build had ${result.errors.length} errors — not restarting`);
          return;
        }
        if (first) { first = false; startElectron(); }
        else scheduleRestart();
      });
    },
  }],
};

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev] shutting down…');
  if (electronProc) {
    try { electronProc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (electronProc) { try { electronProc.kill('SIGKILL'); } catch (_) {} }
      process.exit(code);
    }, 500);
  } else {
    process.exit(code);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[dev] esbuild watching… electron will start after first build');
})().catch(err => {
  console.error('[dev] fatal:', err);
  shutdown(1);
});
