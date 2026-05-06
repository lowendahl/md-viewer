const { app, BrowserWindow, ipcMain, dialog, crashReporter, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');
const url = require('url');
const chokidar = require('chokidar');
const yaml = require('js-yaml');
const { installObservability, emit: obsEmit } = require('./observability');

// Crash reporter MUST start before app.ready to capture native crashes.
// Dumps land under app.getPath('crashDumps').
crashReporter.start({
  productName: 'Chorus',
  companyName: 'Symbiont',
  uploadToServer: false,
  ignoreSystemCrashHandler: false,
});

// V1.4: register a custom scheme that streams arbitrary local files. The
// renderer loads this page over file://, and Chromium blocks file:// →
// file:// cross-origin loads (so inline images and the lightbox failed
// to render attachments). mdv-img:// is treated as a standard scheme,
// bypasses the file:// CORB, and is mapped 1:1 to the absolute path
// after the //. Encoded as encodeURI so spaces survive.
//
// Usage from renderer:  src="mdv-img:///C:/Users/foo/bar.png"
protocol.registerSchemesAsPrivileged([
  { scheme: 'mdv-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

// Disable HW accel to avoid GPU compositor crashes on scroll with the
// heavy Crepe / ProseMirror DOM. Can be overridden with MDV_GPU=1.
if (!process.env.MDV_GPU) {
  app.disableHardwareAcceleration();
}

// Run the Network Service in-process. On corporate Windows machines the
// out-of-process Network Service utility is sometimes killed by EDR
// (Defender / MDE) on launch (STATUS_CONTROL_C_EXIT 0xC000013A), which
// then takes the main process down with it. In-process avoids the
// utility-process attack surface entirely. Override with MDV_OOP_NET=1
// if you ever want the default Chromium behaviour back.
if (!process.env.MDV_OOP_NET) {
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
}

// Reduce helper-process count further. Aggressive EDR (e.g. MDE) sometimes
// kills extra utility processes (audio, GPU info, video decode). Override
// with MDV_HARDEN=0 to disable, or MDV_NO_SANDBOX=1 to also drop sandbox
// (NOTE: --no-sandbox actually made things WORSE on this corp machine —
// renderers got killed in 3s instead of 50s. Leaving sandbox ON by default.)
if (!process.env.MDV_HARDEN || process.env.MDV_HARDEN !== '0') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,RendererCodeIntegrity');
}
if (process.env.MDV_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// Heartbeat — write directly to a tick log every 2s so we know exactly
// when main dies even if observability is filtering or down. Independent
// of the JSONL telemetry. File: ~/.copilot/data/mdviewer-telemetry/tick.log
const tickLog = path.join(os.homedir(), '.copilot', 'data', 'mdviewer-telemetry', 'tick.log');
try { fssync.mkdirSync(path.dirname(tickLog), { recursive: true }); } catch {}
fssync.appendFileSync(tickLog, `\n=== boot pid=${process.pid} ${new Date().toISOString()} ===\n`);
setInterval(() => {
  try { fssync.appendFileSync(tickLog, `tick pid=${process.pid} up=${Math.round(process.uptime())}s ${new Date().toISOString()}\n`); } catch {}
}, 2000);

// Lifecycle event tracing — log every Electron app event so we can see
// whether the app is being asked to quit or whether the process just dies.
for (const ev of ['will-quit', 'before-quit', 'quit', 'window-all-closed', 'browser-window-created', 'render-process-gone', 'child-process-gone']) {
  app.on(ev, (...args) => {
    try { fssync.appendFileSync(tickLog, `app.${ev} pid=${process.pid} ${new Date().toISOString()} ${JSON.stringify(args.slice(1)).slice(0, 200)}\n`); } catch {}
  });
}
process.on('exit', (code) => {
  try { fssync.appendFileSync(tickLog, `process.exit pid=${process.pid} code=${code} ${new Date().toISOString()}\n`); } catch {}
});
process.on('SIGTERM', () => { try { fssync.appendFileSync(tickLog, `SIGTERM pid=${process.pid} ${new Date().toISOString()}\n`); } catch {} });
process.on('SIGINT', () => { try { fssync.appendFileSync(tickLog, `SIGINT pid=${process.pid} ${new Date().toISOString()}\n`); } catch {} });

// Install observability BEFORE any ipcMain.handle() calls — it monkey-patches
// ipcMain.handle to wrap handlers with error capture.
installObservability(app.getVersion());

let win;
let watcher = null;
let currentRoot = null;
let pendingOpenPath = null;

function extractMdPathFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) continue;
    // mdviewer:// custom protocol — paths come in as e.g. "mdviewer://C:/foo/bar.md"
    const m = /^mdviewer:\/\/(.+)$/i.exec(a);
    if (m) {
      let raw = m[1].replace(/\/+$/, '');
      try { raw = decodeURIComponent(raw); } catch {}
      // Forward slashes → backslashes on Windows for absolute paths like C:/...
      if (/^[a-z]:\//i.test(raw)) raw = raw.replace(/\//g, '\\');
      try {
        if (fssync.existsSync(raw) && fssync.statSync(raw).isFile() && /\.(md|markdown)$/i.test(raw)) {
          return raw;
        }
      } catch {}
      continue;
    }
    if (!/\.(md|markdown)$/i.test(a)) continue;
    try {
      const resolved = path.resolve(a);
      if (fssync.existsSync(resolved) && fssync.statSync(resolved).isFile()) return resolved;
    } catch {}
  }
  return null;
}

// Register custom protocol so URLs like
//   mdviewer://C:/Users/me/notes/foo.md
// open the file in this app. On packaged Windows builds the binary path is
// passed through to the OS; in dev we point the registration at electron + the
// project path.
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('mdviewer', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('mdviewer');
  }
} catch {}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const target = extractMdPathFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (target) win.webContents.send('open-md-from-os', target);
    } else if (target) {
      pendingOpenPath = target;
    }
  });
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) win.webContents.send('open-md-from-os', p);
  else pendingOpenPath = p;
});

// macOS: mdviewer:// URLs arrive via open-url.
app.on('open-url', (e, url) => {
  e.preventDefault();
  const m = /^mdviewer:\/\/(.+)$/i.exec(url || '');
  if (!m) return;
  let raw = m[1].replace(/\/+$/, '');
  try { raw = decodeURIComponent(raw); } catch {}
  if (win) win.webContents.send('open-md-from-os', raw);
  else pendingOpenPath = raw;
});

pendingOpenPath = extractMdPathFromArgv(process.argv);

function createWindow() {
  const flagArgs = [];
  for (const f of ['tree', 'editor', 'comments', 'changes']) {
    const env = process.env[`MDV_F_${f.toUpperCase()}`];
    const on = env === undefined ? true : env !== '0';
    if (on) flagArgs.push(`--mdv-flag=${f}`);
  }
  obsEmit({ level: 'info', source: 'main', type: 'main.flags', message: 'feature flags', context: { enabled: flagArgs.map(a => a.split('=')[1]) } });
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Chorus',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0A1224',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: flagArgs,
    },
  });
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  if (process.env.MDV_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.once('did-finish-load', () => {
    if (pendingOpenPath) {
      win.webContents.send('open-md-from-os', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    obsEmit({
      level: 'error',
      source: 'renderer',
      type: 'renderer.did_fail_load',
      message: `${code} ${desc}`,
      context: { url },
    });
  });

  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    obsEmit({
      level: 'fatal',
      source: 'main',
      type: 'preload.error',
      message: err?.message || String(err),
      stack: err?.stack,
      context: { preloadPath },
    });
  });
}

app.whenReady().then(async () => {
  // Register the mdv-img:// handler. Must happen after app.whenReady().
  try {
    protocol.handle('mdv-img', async (req) => {
      try {
        // mdv-img:///C:/path/to/image.png  -> /C:/path/to/image.png  -> C:/path/to/image.png
        let p = decodeURI(new URL(req.url).pathname || '');
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        // Reject anything that doesn't actually exist as a file
        const st = await fs.stat(p).catch(() => null);
        if (!st || !st.isFile()) return new Response('Not found', { status: 404 });
        return net.fetch(url.pathToFileURL(p).toString());
      } catch (err) {
        return new Response('Bad request: ' + String(err?.message || err), { status: 400 });
      }
    });
  } catch (err) {
    obsEmit({ level: 'error', source: 'main', type: 'mdv-img.register.failed', message: String(err?.message || err) });
  }
  createWindow();
  try {
    if (app.isPackaged) {
      const s = await readSettings();
      if (s.autoUpdateCheck !== false) {
        wireAutoUpdater();
        const { autoUpdater } = require('electron-updater');
        // Delay a few seconds so the window is up before any update toast.
        setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
      }
    }
  } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const SIDECAR_RE = /\.review\.(ya?ml|json)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

async function walkMd(dir, opts) {
  const o = opts || {};
  const ignore = new Set((o.ignore || ['node_modules', '.git']).map(s => s.toLowerCase()));
  const showImages = o.showImages !== false;
  const maxEntries = Math.max(500, o.maxEntries || 8000);
  let counted = 0;
  const truncated = { hit: false };
  async function _walk(d) {
    const out = { name: path.basename(d), path: d, type: 'dir', children: [] };
    if (counted >= maxEntries) { truncated.hit = true; return out; }
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
      if (counted >= maxEntries) { truncated.hit = true; break; }
      if (e.name.startsWith('.') || ignore.has(e.name.toLowerCase())) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        counted++;
        const sub = await _walk(p);
        out.children.push(sub);
      } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name) && !SIDECAR_RE.test(e.name)) {
        counted++;
        const sidecar = await findSidecar(p);
        out.children.push({ name: e.name, path: p, type: 'file', hasComments: !!sidecar });
      } else if (showImages && e.isFile() && IMAGE_RE.test(e.name)) {
        counted++;
        out.children.push({ name: e.name, path: p, type: 'image' });
      }
    }
    out.children.sort((a, b) => {
      if (a.type !== b.type) {
        const order = { dir: 0, file: 1, image: 2 };
        return (order[a.type] ?? 9) - (order[b.type] ?? 9);
      }
      return a.name.localeCompare(b.name);
    });
    return out;
  }
  const tree = await _walk(dir);
  tree.truncated = truncated.hit;
  tree.entryCount = counted;
  return tree;
}

async function findSidecar(mdPath) {
  for (const ext of ['.review.yaml', '.review.yml', '.review.json']) {
    const p = mdPath.replace(/\.(md|markdown)$/i, '') + ext;
    try { await fs.access(p); return p; } catch {}
    // Also check appended (foo.md.review.yaml convention)
    const p2 = mdPath + ext;
    try { await fs.access(p2); return p2; } catch {}
  }
  return null;
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('load-tree', async (_e, root) => {
  currentRoot = root;
  const s = await readSettings();
  const tree = await walkMd(root, {
    ignore: s.ignoreGlobs,
    showImages: s.treeImagesVisible !== false,
    maxEntries: s.maxTreeEntries || 8000,
  });
  // Defer chokidar startup slightly to let the renderer paint the tree first.
  setTimeout(() => { try { startWatcher(root); } catch {} }, 250);
  return tree;
});

ipcMain.handle('read-file', async (_e, p) => fs.readFile(p, 'utf8'));
ipcMain.handle('write-file', async (_e, p, content) => { await fs.writeFile(p, content, 'utf8'); return true; });

// Lightweight stat for the path bar — paste a folder or .md path and we
// route correctly without leaking exceptions across the IPC boundary.
ipcMain.handle('stat-path', async (_e, p) => {
  try {
    const st = await fs.stat(p);
    return { ok: true, isDir: st.isDirectory(), isFile: st.isFile() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// Create a new markdown file. If `relPath` is missing, prompt the user.
// Returns { ok, path, error }.
ipcMain.handle('create-md-file', async (_e, opts) => {
  try {
    const root = opts?.root || currentRoot;
    if (!root) return { ok: false, error: 'No folder open' };
    let target;
    if (opts?.relPath) {
      const safe = String(opts.relPath).replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, '');
      target = path.join(root, safe);
    } else if (opts?.absPath) {
      target = opts.absPath;
    } else {
      const def = path.join(opts?.dir || root, opts?.suggestedName || 'untitled.md');
      const res = await dialog.showSaveDialog({
        title: 'New Markdown File',
        defaultPath: def,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      target = res.filePath;
    }
    if (!/\.(md|markdown)$/i.test(target)) target += '.md';
    try { await fs.access(target); return { ok: false, error: 'File already exists', path: target }; } catch {}
    await fs.mkdir(path.dirname(target), { recursive: true });
    const title = path.basename(target, path.extname(target));
    const body = opts?.content ?? `# ${title}\n\n`;
    await fs.writeFile(target, body, 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('create-folder', async (_e, dirPath) => {
  try {
    if (!dirPath) return { ok: false, error: 'No path' };
    try { await fs.access(dirPath); return { ok: false, error: 'Folder already exists', path: dirPath }; } catch {}
    await fs.mkdir(dirPath, { recursive: true });
    return { ok: true, path: dirPath };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('rename-path', async (_e, oldPath, newPath) => {
  try {
    if (!oldPath || !newPath) return { ok: false, error: 'Missing path' };
    if (oldPath === newPath) return { ok: true, path: newPath };
    try { await fs.access(newPath); return { ok: false, error: 'Target already exists' }; } catch {}
    await fs.rename(oldPath, newPath);
    // If a sidecar exists (either convention), rename it to the new appended form.
    const sidecarOld = await findSidecar(oldPath);
    if (sidecarOld) {
      const sidecarNew = newPath + '.review.yaml';
      try { await fs.rename(sidecarOld, sidecarNew); } catch {}
    }
    return { ok: true, path: newPath };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('delete-path', async (_e, p) => {
  try {
    if (!p) return { ok: false, error: 'No path' };
    const { shell } = require('electron');
    await shell.trashItem(p);
    // Also trash sidecar if it's an .md (either naming convention)
    if (/\.(md|markdown)$/i.test(p)) {
      const sc = await findSidecar(p);
      if (sc) { try { await shell.trashItem(sc); } catch {} }
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('show-in-explorer', async (_e, p) => {
  try {
    if (!p) return { ok: false, error: 'No path' };
    const { shell } = require('electron');
    const stat = await fs.stat(p).catch(() => null);
    if (stat && stat.isDirectory()) {
      const r = await shell.openPath(p);
      if (r) return { ok: false, error: r };
    } else {
      shell.showItemInFolder(p);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ---- Wave 1: Find & Connect ------------------------------------------------

// Walk the current root and return a flat list of { name, path, dir }
// (relative path for display). Cached for ~3s to keep Quick Switcher snappy.
let mdListCache = { root: null, ts: 0, items: null };
async function flatListMd(root) {
  if (!root) return [];
  const now = Date.now();
  if (mdListCache.root === root && now - mdListCache.ts < 3000 && mdListCache.items) {
    return mdListCache.items;
  }
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name) && !SIDECAR_RE.test(e.name)) {
        const rel = path.relative(root, p).replace(/\\/g, '/');
        out.push({ name: e.name, path: p, rel, dir: path.dirname(rel) });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  mdListCache = { root, ts: now, items: out };
  return out;
}
ipcMain.handle('list-md-files', async () => flatListMd(currentRoot));

// Full-text search across all .md files (and optionally sidecar comments).
// Bounded: 800 files, 5MB per file, 50 matches per file, 500 total.
ipcMain.handle('search-text', async (_e, opts) => {
  const root = currentRoot;
  if (!root) return { results: [], truncated: false };
  const query = (opts?.query || '').trim();
  if (!query) return { results: [], truncated: false };
  const includeSidecars = opts?.includeSidecars !== false;
  const isRegex = !!opts?.regex;
  let re;
  try {
    re = isRegex
      ? new RegExp(query, 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch (err) {
    return { results: [], truncated: false, error: 'bad regex: ' + err.message };
  }
  const files = await flatListMd(root);
  const results = [];
  let truncated = false;
  let total = 0;
  const MAX_TOTAL = 500;

  // Walk md files
  for (const f of files) {
    if (total >= MAX_TOTAL) { truncated = true; break; }
    let text;
    try {
      const stat = await fs.stat(f.path);
      if (stat.size > 5 * 1024 * 1024) continue;
      text = await fs.readFile(f.path, 'utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= 50) break;
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push({ line: i + 1, snippet: lines[i].slice(0, 240) });
        total++;
        if (total >= MAX_TOTAL) break;
      }
    }
    if (matches.length) results.push({ file: f.path, rel: f.rel, name: f.name, kind: 'md', matches });
  }

  // Walk sidecar comments
  if (includeSidecars && total < MAX_TOTAL) {
    for (const f of files) {
      if (total >= MAX_TOTAL) { truncated = true; break; }
      const sidecar = await findSidecar(f.path);
      if (!sidecar) continue;
      let doc;
      try {
        const raw = await fs.readFile(sidecar, 'utf8');
        doc = sidecar.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      } catch { continue; }
      const comments = doc?.comments || [];
      const matches = [];
      for (const c of comments) {
        if (matches.length >= 20) break;
        const text = (c.text || '') + ' ' + (c.author || '');
        re.lastIndex = 0;
        if (re.test(text)) {
          matches.push({ line: c.line || 1, snippet: (c.text || '').slice(0, 240), commentId: c.id, author: c.author });
          total++;
          if (total >= MAX_TOTAL) break;
        }
      }
      if (matches.length) results.push({ file: f.path, rel: f.rel, name: f.name, kind: 'sidecar', matches });
    }
  }
  return { results, truncated, total };
});

// Find docs that link to the given target via [[Name]] or [[Name|alias]].
// `target` can be a basename (without .md), a basename with .md, or a relative path.
ipcMain.handle('find-backlinks', async (_e, target) => {
  if (!currentRoot || !target) return [];
  const files = await flatListMd(currentRoot);
  const targets = new Set();
  const baseNoExt = target.replace(/\.(md|markdown)$/i, '').toLowerCase();
  const baseName = baseNoExt.split(/[\\/]/).pop();
  targets.add(baseNoExt);
  targets.add(baseName);
  const re = /\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
  const out = [];
  for (const f of files) {
    let text;
    try {
      const stat = await fs.stat(f.path);
      if (stat.size > 5 * 1024 * 1024) continue;
      text = await fs.readFile(f.path, 'utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const linkTarget = m[1].trim().replace(/\.(md|markdown)$/i, '').toLowerCase();
        const linkBase = linkTarget.split(/[\\/]/).pop();
        if (targets.has(linkTarget) || targets.has(linkBase)) {
          hits.push({ line: i + 1, snippet: lines[i].slice(0, 240) });
          break;
        }
      }
      if (hits.length >= 10) break;
    }
    if (hits.length && f.path !== target) {
      out.push({ file: f.path, rel: f.rel, name: f.name, hits });
    }
  }
  return out;
});

// Resolve a [[Name]] reference to the best-matching file path.
// Strategy: exact basename match > basename startsWith > rel-path includes.
ipcMain.handle('resolve-wikilink', async (_e, name) => {
  if (!currentRoot || !name) return null;
  const files = await flatListMd(currentRoot);
  const target = name.trim().replace(/\.(md|markdown)$/i, '').toLowerCase();
  const targetBase = target.split(/[\\/]/).pop();
  // 1. exact basename (case-insensitive)
  let hit = files.find(f => f.name.replace(/\.(md|markdown)$/i, '').toLowerCase() === targetBase);
  if (hit) return hit.path;
  // 2. exact relative path (without ext)
  hit = files.find(f => f.rel.replace(/\.(md|markdown)$/i, '').toLowerCase() === target);
  if (hit) return hit.path;
  // 3. basename startsWith
  hit = files.find(f => f.name.toLowerCase().startsWith(targetBase));
  if (hit) return hit.path;
  // 4. rel-path includes
  hit = files.find(f => f.rel.toLowerCase().includes(target));
  return hit ? hit.path : null;
});

ipcMain.handle('get-folder-stats', async (_e, root) => {
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { exists: false };
    let count = 0;
    let lastMtime = 0;
    async function walk(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p); }
        else if (/\.(md|markdown)$/i.test(e.name)) {
          count++;
          try { const s = await fs.stat(p); if (s.mtimeMs > lastMtime) lastMtime = s.mtimeMs; } catch {}
        }
      }
    }
    await walk(root);
    return { exists: true, mdCount: count, lastModified: lastMtime || st.mtimeMs };
  } catch { return { exists: false }; }
});

ipcMain.handle('read-sidecar', async (_e, mdPath) => {
  const found = await findSidecar(mdPath);
  if (!found) return { path: null, doc: null };
  const raw = await fs.readFile(found, 'utf8');
  let doc;
  try {
    doc = found.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  } catch (err) {
    // V1.3: quarantine the corrupt sidecar so the editor stays usable.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const quarantined = found + '.corrupt-' + stamp;
      await fs.rename(found, quarantined);
      win?.webContents.send('toast', { kind: 'warn', msg: `Sidecar corrupt — moved to ${path.basename(quarantined)}` });
    } catch (qe) {
      // Best-effort; if rename fails, just surface the error.
    }
    return { path: found, doc: null, error: String(err) };
  }
  return { path: found, doc };
});

// ---- Image embedding ------------------------------------------------------
//
// Save a pasted/dropped/picked image next to the markdown file in
// <docDir>/attachments/, using a stable timestamp+slug name. Returns the
// markdown-embeddable relative path (forward-slashes), e.g.
// "attachments/2026-05-02T17-42-00-screenshot.png".
function _imageExt(name, mime) {
  const m = (name || '').match(/\.[a-zA-Z0-9]+$/);
  if (m) return m[0].toLowerCase();
  switch ((mime || '').toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': case 'image/jpg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/svg+xml': return '.svg';
    case 'image/bmp': return '.bmp';
    case 'image/avif': return '.avif';
    default: return '.png';
  }
}
function _imageSlug(name) {
  const base = (name || 'image').replace(/\.[^.]+$/, '');
  const slug = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return slug || 'image';
}
ipcMain.handle('save-image', async (_e, mdPath, data, suggestedName, mimeType) => {
  try {
    if (!mdPath) return { ok: false, error: 'No file open' };
    if (!data) return { ok: false, error: 'No image data' };
    const dir = path.join(path.dirname(mdPath), 'attachments');
    await fs.mkdir(dir, { recursive: true });
    const ext = _imageExt(suggestedName, mimeType);
    const slug = _imageSlug(suggestedName);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let name = `${stamp}-${slug}${ext}`;
    let abs = path.join(dir, name);
    // Avoid collision (extremely unlikely, but safe)
    let n = 1;
    while (true) {
      try { await fs.access(abs); } catch { break; }
      name = `${stamp}-${slug}-${n}${ext}`;
      abs = path.join(dir, name);
      n += 1;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fs.writeFile(abs, buf);
    const rel = ('attachments/' + name).replace(/\\/g, '/');
    return { ok: true, relPath: rel, absPath: abs };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// Resolve the absolute directory of the open document, so the renderer can
// rewrite relative <img src> values to file:// URLs without per-image IPC.
ipcMain.handle('doc-dir', async (_e, mdPath) => {
  if (!mdPath) return null;
  return path.dirname(mdPath).replace(/\\/g, '/');
});

ipcMain.handle('write-sidecar', async (_e, mdPath, doc) => {
  let target = await findSidecar(mdPath);
  if (!target) target = mdPath + '.review.yaml'; // MRSF spec: <name>.md.review.yaml
  const isJson = /\.json$/i.test(target);
  const content = isJson ? JSON.stringify(doc, null, 2) : yaml.dump(doc, { lineWidth: 100, noRefs: true });
  await fs.writeFile(target, content, 'utf8');
  return target;
});

ipcMain.handle('delete-sidecar', async (_e, mdPath) => {
  const found = await findSidecar(mdPath);
  if (found) { try { await fs.unlink(found); } catch {} }
  return true;
});

ipcMain.handle('get-user', async () => {
  let info = {};
  try { info = os.userInfo(); } catch {}
  // Try to enrich with git user.email if available
  let email = process.env.USER_EMAIL || process.env.GIT_AUTHOR_EMAIL || null;
  return {
    name: info.username || os.hostname(),
    username: info.username,
    email,
    host: os.hostname(),
  };
});

function startWatcher(root) {
  if (watcher) watcher.close();
  watcher = chokidar.watch(root, {
    ignored: /(^|[\\\/])(\.|node_modules)/,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  const send = (event, p) => {
    const isMd = /\.(md|markdown)$/i.test(p) && !SIDECAR_RE.test(p);
    const isSidecar = SIDECAR_RE.test(p);
    if (!isMd && !isSidecar) return;
    win?.webContents.send('fs-event', { event, path: p, isSidecar, time: Date.now() });
  };
  watcher.on('add', p => { send('added', p); if ((/\.(md|markdown)$/i.test(p) && !SIDECAR_RE.test(p)) || IMAGE_RE.test(p)) win?.webContents.send('tree-dirty'); });
  watcher.on('change', p => send('changed', p));
  watcher.on('unlink', p => { send('removed', p); if ((/\.(md|markdown)$/i.test(p) && !SIDECAR_RE.test(p)) || IMAGE_RE.test(p)) win?.webContents.send('tree-dirty'); });
  watcher.on('addDir', () => win?.webContents.send('tree-dirty'));
  watcher.on('unlinkDir', () => win?.webContents.send('tree-dirty'));
}


// ============================================================================
// v1.3.0: settings, drafts, updates, print, drag-out, app info
// ============================================================================

const SETTINGS_DEFAULT = {
  theme: 'frame-dark',
  lightUi: false,
  fontSize: 15,
  imageFolder: 'attachments',
  ignoreGlobs: ['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'release'],
  maxTreeEntries: 8000,
  autoUpdateCheck: true,
  updateManifestUrl: '',
  telemetryOptIn: true,
  associatedAtInstall: false,
  showResolvedComments: false,
  treeImagesVisible: true,
  commentOverlay: 'inline', // 'inline' | 'gutter-only' | 'off'  (V1.4)
  csuLinkifyEnabled: true,  // V1.5: auto-linkify CSU/MSX/eSXP IDs
};

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    return Object.assign({}, SETTINGS_DEFAULT, JSON.parse(raw));
  } catch { return { ...SETTINGS_DEFAULT }; }
}
async function writeSettings(s) {
  const merged = Object.assign({}, SETTINGS_DEFAULT, s || {});
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

ipcMain.handle('settings:get', async () => readSettings());
ipcMain.handle('settings:set', async (_e, partial) => {
  const cur = await readSettings();
  return writeSettings(Object.assign({}, cur, partial || {}));
});

// ----- Drafts (autosave snapshots) -------------------------------------------
function draftsDir() { return path.join(app.getPath('userData'), 'drafts'); }
function draftHash(p) {
  // Stable per-file id (filesystem-safe). Not crypto, just uniqueness.
  let h = 0; const s = String(p || '').toLowerCase();
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36) + '-' + path.basename(p || 'unnamed').replace(/[^\w.-]+/g, '_').slice(0, 32);
}
async function draftsEnsure() { await fs.mkdir(draftsDir(), { recursive: true }); }

ipcMain.handle('draft:save', async (_e, mdPath, content) => {
  try {
    if (!mdPath) return { ok: false, error: 'No path' };
    await draftsEnsure();
    const id = draftHash(mdPath);
    const target = path.join(draftsDir(), id + '.md');
    const meta = { mdPath, savedAt: Date.now() };
    await fs.writeFile(target, content || '', 'utf8');
    await fs.writeFile(target + '.json', JSON.stringify(meta), 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});
ipcMain.handle('draft:get', async (_e, mdPath) => {
  try {
    if (!mdPath) return null;
    const id = draftHash(mdPath);
    const target = path.join(draftsDir(), id + '.md');
    const metaPath = target + '.json';
    const [content, meta] = await Promise.all([
      fs.readFile(target, 'utf8').catch(() => null),
      fs.readFile(metaPath, 'utf8').then(JSON.parse).catch(() => ({})),
    ]);
    if (content == null) return null;
    return { content, savedAt: meta.savedAt || 0, mdPath };
  } catch { return null; }
});
ipcMain.handle('draft:clear', async (_e, mdPath) => {
  try {
    if (!mdPath) return { ok: true };
    const id = draftHash(mdPath);
    const target = path.join(draftsDir(), id + '.md');
    await fs.unlink(target).catch(() => {});
    await fs.unlink(target + '.json').catch(() => {});
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});
ipcMain.handle('draft:list', async () => {
  try {
    await draftsEnsure();
    const entries = await fs.readdir(draftsDir());
    const drafts = [];
    for (const e of entries) {
      if (!e.endsWith('.md.json') && !e.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(draftsDir(), e), 'utf8'));
        drafts.push(meta);
      } catch {}
    }
    return drafts.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch { return []; }
});

// ----- App info / About ------------------------------------------------------
ipcMain.handle('app:info', async () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  userData: app.getPath('userData'),
  logs: app.getPath('logs'),
  crashDumps: app.getPath('crashDumps'),
}));

ipcMain.handle('app:open-path', async (_e, p) => {
  const { shell } = require('electron');
  const r = await shell.openPath(p);
  return r ? { ok: false, error: r } : { ok: true };
});

// ----- Manual & Changelog ---------------------------------------------------
ipcMain.handle('manual:list', async () => {
  try {
    const dir = path.join(app.getAppPath(), 'manual');
    const entries = await fs.readdir(dir);
    return entries.filter(n => n.toLowerCase().endsWith('.md')).sort();
  } catch { return []; }
});
ipcMain.handle('manual:read', async (_e, name) => {
  if (!name || /[\\/]/.test(name) || name.includes('..')) throw new Error('Invalid name');
  const p = path.join(app.getAppPath(), 'manual', name);
  return fs.readFile(p, 'utf8');
});
ipcMain.handle('changelog:read', async () => {
  try { return await fs.readFile(path.join(app.getAppPath(), 'CHANGELOG.md'), 'utf8'); }
  catch (e) { return '# Changelog\n\n_Not bundled in this build._'; }
});

// ----- Print to PDF ----------------------------------------------------------
ipcMain.handle('print:pdf', async (_e, suggestedName) => {
  try {
    if (!win) return { ok: false, error: 'No window' };
    const r = await dialog.showSaveDialog(win, {
      title: 'Export to PDF',
      defaultPath: (suggestedName || 'document') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    });
    await fs.writeFile(r.filePath, data);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ----- Drag-out from tree to OS / other apps --------------------------------
ipcMain.on('start-drag', (e, filePath) => {
  try {
    if (!filePath || !fssync.existsSync(filePath)) return;
    e.sender.startDrag({
      file: filePath,
      icon: path.join(__dirname, 'build', 'icon.ico'),
    });
  } catch (err) {
    obsEmit({ level: 'warn', source: 'main', type: 'main.startDrag.failed', message: String(err) });
  }
});

// ----- Auto-update check ----------------------------------------------------
// Lightweight: fetches a JSON manifest and tells the renderer about a newer
// version. No download mechanism — user clicks "Open download page" in the
// toast. This avoids bundling electron-updater + signing infra for v1.
//
// Manifest shape: { "version": "1.3.1", "downloadUrl": "https://...", "notes": "..." }
function semverGt(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
// electron-updater pulls releases directly from the configured GitHub repo
// (see "publish" in package.json). On a newer release it downloads in the
// background and installs on next quit. Disabled in dev (unpackaged) builds.
let _updaterWired = false;
let _updaterState = { status: 'idle', current: app.getVersion(), latest: null, error: null, progress: 0 };
function wireAutoUpdater() {
  if (_updaterWired) return;
  _updaterWired = true;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => { _updaterState.status = 'checking'; });
    autoUpdater.on('update-available', (info) => { _updaterState.status = 'downloading'; _updaterState.latest = info?.version || null; broadcastUpdate(); });
    autoUpdater.on('update-not-available', (info) => { _updaterState.status = 'up-to-date'; _updaterState.latest = info?.version || null; broadcastUpdate(); });
    autoUpdater.on('download-progress', (p) => { _updaterState.status = 'downloading'; _updaterState.progress = Math.round(p?.percent || 0); broadcastUpdate(); });
    autoUpdater.on('update-downloaded', (info) => { _updaterState.status = 'ready'; _updaterState.latest = info?.version || _updaterState.latest; broadcastUpdate(); });
    autoUpdater.on('error', (err) => { _updaterState.status = 'error'; _updaterState.error = String(err?.message || err); broadcastUpdate(); });
  } catch (err) {
    _updaterState.status = 'error';
    _updaterState.error = 'electron-updater not available: ' + String(err?.message || err);
  }
}
function broadcastUpdate() {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    for (const w of wins) { try { w.webContents.send('updates:state', _updaterState); } catch {} }
  } catch {}
}
ipcMain.handle('updates:check', async () => {
  try {
    if (!app.isPackaged) {
      return { ok: true, current: app.getVersion(), latest: app.getVersion(), newer: false, dev: true, message: 'Auto-update disabled in dev build' };
    }
    wireAutoUpdater();
    const { autoUpdater } = require('electron-updater');
    const result = await autoUpdater.checkForUpdates();
    const cur = app.getVersion();
    const latest = result?.updateInfo?.version || cur;
    const newer = semverGt(latest, cur);
    return { ok: true, current: cur, latest, newer, status: _updaterState.status };
  } catch (err) {
    const raw = String(err?.message || err);
    // electron-updater surfaces SAX parser errors when it gets an HTML login
    // page (e.g. EMU SSO redirect) instead of latest.yml. Translate those into
    // something a human can act on.
    let friendly = raw;
    if (/Attribute without value|Unexpected token|YAMLException|Invalid character/i.test(raw)) {
      friendly = 'Update server returned an unexpected response (likely a private/SSO-protected release feed). Auto-updates are not configured for this build.';
    } else if (/404|Not Found|HttpError/i.test(raw)) {
      friendly = 'Update feed not found. The release may not be published yet.';
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(raw)) {
      friendly = 'Could not reach update server. Check your internet connection.';
    }
    return { ok: false, error: friendly, raw };
  }
});
ipcMain.handle('updates:state', async () => _updaterState);
ipcMain.handle('updates:install', async () => {
  try {
    if (!app.isPackaged) return { ok: false, error: 'Dev build' };
    const { autoUpdater } = require('electron-updater');
    if (_updaterState.status !== 'ready') return { ok: false, error: 'No update downloaded' };
    setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch {} });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('open-external', async (_e, url) => {
  try {
    if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Only http(s) allowed' };
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ----- Last-file restore -----------------------------------------------------
// Stored in settings.json as { lastFile: { path, scrollTop } }. Renderer reads
// at boot via settings:get, writes on file open + on dirty/save. Trivial wrap:
ipcMain.handle('lastfile:set', async (_e, info) => {
  const cur = await readSettings();
  cur.lastFile = info || null;
  await writeSettings(cur);
  return { ok: true };
});

// ============================================================================
// V1.4: Usage analytics — aggregates events from the existing observability
// NDJSON log (events-YYYY-MM-DD.jsonl). All processing happens locally; this
// is the source of truth for the in-app Insights panel.
// ============================================================================
const { readEvents, listLogDates, logFilePath, TELEMETRY_DIR } = require('./observability');

function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[idx];
}

ipcMain.handle('analytics:snapshot', async (_e, opts) => {
  try {
    const days = Math.max(1, Math.min(365, opts?.days || 30));
    const settings = await readSettings();
    if (settings.telemetryOptIn === false) {
      return { disabled: true, reason: 'telemetryOptIn=false' };
    }
    // Walk the last N day files. readEvents reads one date at a time.
    const wantDates = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today.getTime() - i * 86400000);
      wantDates.push(d.toISOString().slice(0, 10));
    }
    const allDates = (await listLogDates().catch(() => [])) || [];
    const dates = wantDates.filter(d => allDates.includes(d));
    const cmdCounts = new Map();   // id -> count
    const featureCounts = new Map();
    const sessionDays = new Map(); // YYYY-MM-DD -> Set<sessionId>
    const perfBuckets = new Map(); // label -> [durations]
    let totalEvents = 0;
    for (const d of dates) {
      let evs;
      try { evs = await readEvents({ date: d }); } catch { continue; }
      sessionDays.set(d, sessionDays.get(d) || new Set());
      for (const ev of evs) {
        totalEvents++;
        if (ev.type === 'mdv.command.invoke') {
          const id = ev.context?.id || ev.message;
          if (id) cmdCounts.set(id, (cmdCounts.get(id) || 0) + 1);
        } else if (ev.type === 'mdv.feature.use') {
          const id = ev.context?.id || ev.message;
          if (id) featureCounts.set(id, (featureCounts.get(id) || 0) + 1);
        } else if (ev.type === 'mdv.session.start') {
          const sid = ev.context?.sessionId;
          if (sid) sessionDays.get(d).add(sid);
        } else if (ev.type === 'mdv.perf.refresh.long') {
          const label = ev.context?.label || ev.message || 'refresh';
          const ms = ev.context?.duration_ms;
          if (Number.isFinite(ms)) {
            if (!perfBuckets.has(label)) perfBuckets.set(label, []);
            perfBuckets.get(label).push(ms);
          }
        }
      }
    }
    // Top commands
    const allCommands = [...cmdCounts.entries()].map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
    const topCommands = allCommands.slice(0, 25);
    // Sessions per day, oldest first
    const sessionsPerDay = wantDates.slice().reverse().map(d => ({
      date: d,
      count: sessionDays.has(d) ? sessionDays.get(d).size : 0,
    }));
    const sessionCount = sessionsPerDay.reduce((s, r) => s + r.count, 0);
    // Perf hotspots
    const perfHotspots = [...perfBuckets.entries()].map(([label, arr]) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      return {
        label,
        count: arr.length,
        median: _percentile(sorted, 50),
        p95: _percentile(sorted, 95),
      };
    }).sort((a, b) => b.count - a.count);
    return {
      disabled: false,
      days,
      totalEvents,
      sessionCount,
      topCommands,
      allCommands,
      featureCounts: [...featureCounts.entries()].map(([id, count]) => ({ id, count })),
      sessionsPerDay,
      perfHotspots,
      logPath: logFilePath ? logFilePath() : null,
      logDir: TELEMETRY_DIR,
    };
  } catch (err) {
    return { disabled: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('analytics:open-log', async () => {
  try {
    const { shell } = require('electron');
    const p = logFilePath ? logFilePath() : null;
    if (!p) return { ok: false, error: 'no log path' };
    const r = await shell.openPath(p);
    return r ? { ok: false, error: r } : { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('analytics:open-log-dir', async () => {
  try {
    const { shell } = require('electron');
    const dir = TELEMETRY_DIR;
    if (!dir) return { ok: false, error: 'no log dir' };
    const r = await shell.openPath(dir);
    return r ? { ok: false, error: r } : { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ---- Symbiont Chorus (MCP server) ---------------------------------------
// Discovery: %LOCALAPPDATA%\Symbiont\chorus.json
// Endpoints: GET /health, POST /ask, POST /reply
// Chorus writes results into the doc's MRSF sidecar; viewer's existing
// chokidar watcher renders them in the gutter. Renderer never speaks
// HTTP directly so we sidestep CSP / mixed-content concerns.
const _http = require('http');
function _bridgeDiscoveryPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const current = path.join(local, 'Symbiont', 'chorus.json');
  if (fssync.existsSync(current)) return current;
  // Legacy fallback during the rename window.
  const legacy = path.join(local, 'Clawpilot', 'md-viewer-bridge.json');
  return legacy;
}
function _readBridgeInfo() {
  try {
    const raw = fssync.readFileSync(_bridgeDiscoveryPath(), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}
function _bridgeFetch(method, p, body) {
  return new Promise((resolve) => {
    const info = _readBridgeInfo();
    if (!info?.port) return resolve({ ok: false, error: 'Chorus not running', code: 'NO_CHORUS' });
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = _http.request(
      {
        host: '127.0.0.1', port: info.port, path: p, method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        timeout: 8000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const json = buf ? JSON.parse(buf) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, ...(json || {}) });
            } else {
              resolve({ ok: false, status: res.statusCode, error: json?.error || buf });
            }
          } catch (err) {
            resolve({ ok: false, error: 'invalid bridge response: ' + err.message });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message, code: err.code }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'chorus timeout', code: 'TIMEOUT' }); });
    if (data) req.write(data);
    req.end();
  });
}

ipcMain.handle('bridge:health', async () => {
  const info = _readBridgeInfo();
  if (!info?.port) return { ok: false, error: 'Chorus not running', code: 'NO_CHORUS' };
  const res = await _bridgeFetch('GET', '/health');
  return res.ok ? { ok: true, port: info.port, ...res } : res;
});
ipcMain.handle('bridge:ask', async (_e, payload) => _bridgeFetch('POST', '/ask', payload));
ipcMain.handle('bridge:reply', async (_e, payload) => _bridgeFetch('POST', '/reply', payload));