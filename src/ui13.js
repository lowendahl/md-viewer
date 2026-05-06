// src/ui13.js — V1.3.0 UI features: toasts, settings, about, find,
// tree-filter, light theme, drafts recovery, update check, print, drag-out.
// Imported once from renderer.js. Self-mounting.

const api = window.api;

// ---------------------------------------------------------------------------
// 1) Toast notifications
// ---------------------------------------------------------------------------
function ensureToastStack() {
  let s = document.getElementById('toast-stack');
  if (!s) {
    s = document.createElement('div');
    s.id = 'toast-stack';
    document.body.appendChild(s);
  }
  return s;
}
function toast(kind, msg, opts) {
  const stack = ensureToastStack();
  const o = opts || {};
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = String(msg);
  el.appendChild(text);
  if (o.action && o.actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = o.actionLabel;
    btn.onclick = (ev) => { ev.stopPropagation(); try { o.action(); } catch {} dismiss(); };
    el.appendChild(btn);
  }
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.onclick = () => dismiss();
  el.appendChild(close);
  stack.appendChild(el);
  let timer = null;
  const dur = o.duration ?? (kind === 'error' ? 8000 : 4500);
  const dismiss = () => {
    if (!el.parentNode) return;
    clearTimeout(timer);
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 220);
  };
  if (dur > 0) timer = setTimeout(dismiss, dur);
  return { dismiss };
}
window.toast = {
  info: (m, o) => toast('info', m, o),
  success: (m, o) => toast('success', m, o),
  warn: (m, o) => toast('warn', m, o),
  error: (m, o) => toast('error', m, o),
};

// ---------------------------------------------------------------------------
// 2) Settings store + light theme + VS Code shell class
// ---------------------------------------------------------------------------
let _settings = null;
async function loadSettings() {
  if (_settings) return _settings;
  try { _settings = await api.getSettings(); } catch { _settings = {}; }
  return _settings;
}
async function saveSettings(partial) {
  const merged = await api.setSettings(partial);
  _settings = merged;
  applyShellPrefs(merged);
  return merged;
}
function applyShellPrefs(s) {
  document.body.classList.toggle('light', !!s.lightUi);
  document.body.classList.toggle('vscode-shell', s.vscodeShell !== false); // ON by default
  if (s.fontSize) document.documentElement.style.setProperty('--mdv-font-size', `${s.fontSize}px`);
  if (s.editorFontSize) document.documentElement.style.setProperty('--mdv-editor-font-size', `${s.editorFontSize}px`);
  // V1.4: comment overlay visibility ('inline' | 'gutter-only' | 'off')
  const co = s.commentOverlay || 'inline';
  document.body.classList.remove('mdv-cmt-inline', 'mdv-cmt-gutter', 'mdv-cmt-off');
  document.body.classList.add(
    co === 'off' ? 'mdv-cmt-off' :
    co === 'gutter-only' ? 'mdv-cmt-gutter' : 'mdv-cmt-inline'
  );
  // Push opt-in state into analytics module if loaded.
  try { window.MDVAnalytics?.setOptIn?.(s.telemetryOptIn !== false); } catch {}
}

// V1.4: cycle comment overlay mode (called from 💬 topbar button)
async function cycleCommentOverlay() {
  const order = ['inline', 'gutter-only', 'off'];
  const cur = (_settings && _settings.commentOverlay) || 'inline';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  await saveSettings({ commentOverlay: next });
  try { window.MDVAnalytics?.track('comments.toggle', { mode: next }); } catch {}
  window.toast?.info?.('Comments: ' + next);
}

// ---------------------------------------------------------------------------
// 3) Modal helpers
// ---------------------------------------------------------------------------
function openModal(title, contentNode, opts) {
  const o = opts || {};
  const overlay = document.createElement('div');
  overlay.className = 'mdv-modal-overlay';
  const card = document.createElement('div');
  card.className = 'mdv-modal-card' + (o.wide ? ' wide' : '');
  const head = document.createElement('div');
  head.className = 'mdv-modal-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'mdv-modal-title';
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'mdv-modal-close';
  closeBtn.textContent = '×';
  head.appendChild(titleEl); head.appendChild(closeBtn);
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'mdv-modal-body';
  body.appendChild(contentNode);
  card.appendChild(body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  closeBtn.onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  return { overlay, card, body, close };
}

// ---------------------------------------------------------------------------
// 4) Settings dialog
// ---------------------------------------------------------------------------
async function openSettings() {
  const s = await loadSettings();
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="mdv-form">
      <h3>Appearance</h3>
      <label class="mdv-row">
        <span>UI theme</span>
        <select data-key="lightUi">
          <option value="false">Dark (default)</option>
          <option value="true">Light</option>
        </select>
      </label>
      <label class="mdv-row">
        <span>Shell style</span>
        <select data-key="vscodeShell">
          <option value="true">VS Code (default)</option>
          <option value="false">Classic MD Viewer</option>
        </select>
      </label>
      <label class="mdv-row">
        <span>UI font size (px)</span>
        <input data-key="fontSize" type="number" min="11" max="20" />
      </label>
      <label class="mdv-row">
        <span>Editor font size (px)</span>
        <input data-key="editorFontSize" type="number" min="12" max="24" />
      </label>

      <h3>Behavior</h3>
      <label class="mdv-row">
        <span>Show images in tree</span>
        <input data-key="treeImagesVisible" type="checkbox" />
      </label>
      <label class="mdv-row">
        <span>Image folder name</span>
        <input data-key="imageFolder" type="text" />
      </label>
      <label class="mdv-row">
        <span>Max tree entries (perf cap)</span>
        <input data-key="maxTreeEntries" type="number" min="500" max="50000" step="500" />
      </label>
      <label class="mdv-row">
        <span>Ignore folder names (comma-separated)</span>
        <input data-key="ignoreGlobs" type="text" />
      </label>

      <h3>Updates</h3>
      <label class="mdv-row">
        <span>Check for updates on launch</span>
        <input data-key="autoUpdateCheck" type="checkbox" />
      </label>
      <label class="mdv-row">
        <span>Manifest URL</span>
        <input data-key="updateManifestUrl" type="text" placeholder="https://example.com/mdv-latest.json" />
      </label>
      <div class="mdv-row">
        <span></span>
        <button class="btn-blue-ghost" id="settings-check-now">Check now</button>
      </div>

      <h3>Comments</h3>
      <label class="mdv-row">
        <span>Comment overlay</span>
        <select data-key="commentOverlay" data-type="string">
          <option value="inline">Inline highlights + gutter</option>
          <option value="gutter-only">Gutter markers only</option>
          <option value="off">Off (rail only)</option>
        </select>
      </label>

      <h3>Privacy</h3>
      <label class="mdv-row">
        <span>Anonymous telemetry (local only)</span>
        <input data-key="telemetryOptIn" type="checkbox" />
      </label>
      <div class="mdv-row">
        <span></span>
        <span class="mdv-muted">Events written to <code id="settings-userdata"></code>. Open the 📊 Insights panel to see what's collected. Disable to stop recording immediately.</span>
      </div>
    </div>
    <div class="mdv-modal-foot">
      <button class="btn-blue-ghost" id="settings-cancel">Cancel</button>
      <button class="btn-blue" id="settings-save">Save</button>
    </div>
  `;
  // Hydrate
  const fields = root.querySelectorAll('[data-key]');
  fields.forEach((f) => {
    const k = f.dataset.key;
    const v = s[k];
    if (f.type === 'checkbox') f.checked = !!v;
    else if (f.tagName === 'SELECT' && f.dataset.type === 'string') f.value = v != null ? String(v) : f.value;
    else if (f.tagName === 'SELECT') f.value = String(!!v);
    else if (Array.isArray(v)) f.value = v.join(', ');
    else if (v != null) f.value = v;
  });
  try {
    const info = await api.appInfo();
    root.querySelector('#settings-userdata').textContent = info.userData;
  } catch {}
  const m = openModal('Settings', root, { wide: true });
  root.querySelector('#settings-cancel').onclick = () => m.close();
  root.querySelector('#settings-check-now').onclick = async (e) => {
    e.preventDefault();
    await runUpdateCheck(true);
  };
  root.querySelector('#settings-save').onclick = async () => {
    const partial = {};
    fields.forEach((f) => {
      const k = f.dataset.key;
      if (f.type === 'checkbox') partial[k] = !!f.checked;
      else if (f.tagName === 'SELECT' && f.dataset.type === 'string') partial[k] = f.value;
      else if (f.tagName === 'SELECT') partial[k] = f.value === 'true';
      else if (f.type === 'number') partial[k] = parseInt(f.value, 10) || 0;
      else if (k === 'ignoreGlobs') partial[k] = f.value.split(',').map((x) => x.trim()).filter(Boolean);
      else partial[k] = f.value;
    });
    await saveSettings(partial);
    m.close();
    window.toast.success('Settings saved');
  };
}

// ---------------------------------------------------------------------------
// 5) About dialog (with error report)
// ---------------------------------------------------------------------------
async function openAbout() {
  let info = {};
  try { info = await api.appInfo(); } catch {}
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="mdv-about">
      <div class="mdv-about-banner"></div>
      <h2>MD Viewer</h2>
      <p class="mdv-muted">A focused, fast Markdown editor with Sidemark review comments.</p>
      <table class="mdv-kv">
        <tr><td>Version</td><td>${escHtml(info.version || '?')}</td></tr>
        <tr><td>Electron</td><td>${escHtml(info.electron || '?')}</td></tr>
        <tr><td>Chrome</td><td>${escHtml(info.chrome || '?')}</td></tr>
        <tr><td>Node</td><td>${escHtml(info.node || '?')}</td></tr>
        <tr><td>Platform</td><td>${escHtml((info.platform || '?') + ' / ' + (info.arch || ''))}</td></tr>
      </table>
      <div class="mdv-about-actions">
        <button class="btn-blue-ghost" id="about-manual">📖 Open manual</button>
        <button class="btn-blue-ghost" id="about-changelog">📜 View changelog</button>
        <button class="btn-blue-ghost" id="about-check">Check for updates</button>
        <button class="btn-blue-ghost" id="about-userdata">Open data folder</button>
        <button class="btn-blue-ghost" id="about-logs">Open logs folder</button>
        <button class="btn-blue-ghost" id="about-report">Copy diagnostics</button>
      </div>
    </div>
  `;
  const m = openModal('About MD Viewer', root);
  root.querySelector('#about-manual').onclick = () => openManual();
  root.querySelector('#about-changelog').onclick = () => openChangelog();
  root.querySelector('#about-check').onclick = () => runUpdateCheck(true);
  root.querySelector('#about-userdata').onclick = () => api.appOpenPath(info.userData);
  root.querySelector('#about-logs').onclick = () => api.appOpenPath(info.logs);
  root.querySelector('#about-report').onclick = async () => {
    const diag = {
      version: info.version,
      electron: info.electron,
      chrome: info.chrome,
      node: info.node,
      platform: info.platform,
      arch: info.arch,
      userAgent: navigator.userAgent,
      time: new Date().toISOString(),
      url: location.href,
    };
    try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 2)); window.toast.success('Diagnostics copied to clipboard'); }
    catch { window.toast.warn('Clipboard blocked'); }
  };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// 5b) In-app manual + changelog viewer
// ---------------------------------------------------------------------------
function _md() { return window.marked || window._marked; }
function _renderMd(text) {
  const m = _md();
  if (m && typeof m.parse === 'function') return m.parse(text);
  if (typeof m === 'function') return m(text);
  return '<pre>' + escHtml(text) + '</pre>';
}

async function openChangelog() {
  let text = '';
  try { text = await api.changelogRead(); }
  catch { text = '# Changelog\n\n_Could not load changelog._'; }
  const root = document.createElement('div');
  root.className = 'mdv-doc-modal';
  root.innerHTML = `<div class="mdv-doc-body markdown-body">${_renderMd(text)}</div>`;
  openModal('Changelog', root, { wide: true });
}

async function openManual() {
  let files = [];
  try { files = await api.manualList(); } catch {}
  if (!files.length) files = ['README.md'];
  const root = document.createElement('div');
  root.className = 'mdv-doc-modal mdv-manual';
  root.innerHTML = `
    <div class="mdv-manual-nav"></div>
    <div class="mdv-doc-body markdown-body">Loading…</div>
  `;
  const nav = root.querySelector('.mdv-manual-nav');
  const body = root.querySelector('.mdv-doc-body');
  const order = ['README.md', 'quick-start.md', 'shortcuts.md', 'settings.md'];
  const sorted = files.slice().sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  function label(name) {
    if (name.toLowerCase() === 'readme.md') return 'Overview';
    return name.replace(/\.md$/i, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  async function load(name) {
    try {
      const t = await api.manualRead(name);
      body.innerHTML = _renderMd(t);
      body.scrollTop = 0;
      nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.name === name));
    } catch (e) {
      body.innerHTML = '<p>Could not load <code>' + escHtml(name) + '</code></p>';
    }
  }
  sorted.forEach(name => {
    const b = document.createElement('button');
    b.textContent = label(name);
    b.dataset.name = name;
    b.onclick = () => load(name);
    nav.appendChild(b);
  });
  // intercept clicks to relative .md links inside the body
  body.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) return; // let external open normally
    if (href.startsWith('#')) return;
    e.preventDefault();
    const name = href.replace(/^\.\//, '').split('/').pop();
    if (/^CHANGELOG\.md$/i.test(name) || href.includes('CHANGELOG')) { openChangelog(); return; }
    if (/\.md$/i.test(name)) load(name);
  });
  openModal('Manual', root, { wide: true });
  load(sorted[0]);
}

// ---------------------------------------------------------------------------
// 6) Update check
// ---------------------------------------------------------------------------
async function runUpdateCheck(interactive) {
  let r;
  try { r = await api.checkUpdates(); }
  catch (e) { if (interactive) window.toast.error('Update check failed'); return; }
  if (!r.ok) {
    if (interactive) {
      const raw = String(r.error || '');
      // Sax/XML parser dumps ("Attribute without value\nLine: ...\nColumn: ...")
      // leak when the release feed returns HTML (e.g. SAML/SSO redirect from a
      // private GitHub repo). Surface a friendlier message instead.
      const looksLikeParserDump = /Line:\s*\d+/.test(raw) && /Column:\s*\d+/.test(raw);
      const msg = !raw ? 'No update manifest configured'
        : looksLikeParserDump ? 'Update feed unreadable (release repo may be private or returning HTML)'
        : raw;
      window.toast.warn(msg);
    }
    return;
  }
  if (r.newer && r.downloadUrl) {
    window.toast.info(`Update available: v${r.latest} (you have v${r.current})`, {
      duration: 0,
      actionLabel: 'Download',
      action: () => api.openExternal(r.downloadUrl),
    });
  } else if (interactive) {
    window.toast.success(`You're on the latest version (v${r.current})`);
  }
}

// ---------------------------------------------------------------------------
// 7) Find-in-file (Ctrl+F) — lightweight DOM-based
// ---------------------------------------------------------------------------
function installFindBar() {
  // V1.4: idempotent — never bind twice. The repeated installs were the
  // proximate cause of the "find bar always opens" regression because the
  // Ctrl+F handler kept stacking on document.
  if (document.getElementById('find-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'find-bar';
  bar.className = 'hidden';
  bar.innerHTML = `
    <input type="text" id="find-input" placeholder="Find in file…" />
    <span id="find-count">0/0</span>
    <button id="find-prev" title="Previous (Shift+Enter)">‹</button>
    <button id="find-next" title="Next (Enter)">›</button>
    <button id="find-close" title="Close (Esc)">×</button>
  `;
  document.body.appendChild(bar);
  const inp = bar.querySelector('#find-input');
  const cnt = bar.querySelector('#find-count');
  let matches = []; let idx = -1;
  const editorHost = document.getElementById('editor-host');
  function clearMarks() {
    if (!editorHost) return;
    editorHost.querySelectorAll('mark.mdv-find-mark').forEach((m) => {
      const t = document.createTextNode(m.textContent);
      m.replaceWith(t);
    });
    matches = []; idx = -1; cnt.textContent = '0/0';
  }
  function findAll(q) {
    clearMarks();
    if (!q || !editorHost) return;
    const lower = q.toLowerCase();
    const walker = document.createTreeWalker(editorHost, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT;
        if (n.parentElement?.closest('.mdv-modal-overlay,#find-bar,#toast-stack,#lightbox')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const hits = [];
    let n;
    while ((n = walker.nextNode())) hits.push(n);
    hits.forEach((textNode) => {
      const v = textNode.nodeValue;
      const lv = v.toLowerCase();
      let i = 0; let last = 0; const frag = document.createDocumentFragment();
      while ((i = lv.indexOf(lower, last)) !== -1) {
        if (i > last) frag.appendChild(document.createTextNode(v.slice(last, i)));
        const mark = document.createElement('mark');
        mark.className = 'mdv-find-mark';
        mark.textContent = v.slice(i, i + q.length);
        frag.appendChild(mark);
        matches.push(mark);
        last = i + q.length;
      }
      if (last > 0) {
        if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)));
        textNode.replaceWith(frag);
      }
    });
    if (matches.length) { idx = 0; focusMatch(); }
    cnt.textContent = `${matches.length ? idx + 1 : 0}/${matches.length}`;
  }
  function focusMatch() {
    matches.forEach((m, i) => m.classList.toggle('mdv-find-current', i === idx));
    const cur = matches[idx];
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    cnt.textContent = `${matches.length ? idx + 1 : 0}/${matches.length}`;
  }
  function step(delta) {
    if (!matches.length) return;
    idx = (idx + delta + matches.length) % matches.length;
    focusMatch();
  }
  function open() {
    bar.classList.remove('hidden');
    inp.value = '';
    inp.focus();
    clearMarks();
    document.addEventListener('keydown', onDocKey, true);
    document.addEventListener('mousedown', onDocClick, true);
    try { window.MDVAnalytics?.track('find.open'); } catch {}
  }
  function close() {
    bar.classList.add('hidden');
    clearMarks();
    document.removeEventListener('keydown', onDocKey, true);
    document.removeEventListener('mousedown', onDocClick, true);
    try { window.MDVAnalytics?.track('find.close'); } catch {}
  }
  function onDocKey(e) {
    if (e.key === 'Escape' && !bar.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  function onDocClick(e) {
    if (bar.classList.contains('hidden')) return;
    // Click outside the bar closes it
    if (!bar.contains(e.target)) close();
  }
  inp.addEventListener('input', () => findAll(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { step(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  bar.querySelector('#find-prev').addEventListener('click', (e) => { e.preventDefault(); step(-1); });
  bar.querySelector('#find-next').addEventListener('click', (e) => { e.preventDefault(); step(1); });
  bar.querySelector('#find-close').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) {
      // Don't hijack Ctrl-Shift-F (full-text search overlay)
      e.preventDefault();
      open();
    }
  });
}

// ---------------------------------------------------------------------------
// 8) Tree filter input
// ---------------------------------------------------------------------------
function installTreeFilter() {
  const sidebar = document.getElementById('sidebar-head');
  const tree = document.getElementById('tree');
  if (!sidebar || !tree) return;
  const wrap = document.createElement('div');
  wrap.className = 'tree-filter-wrap';
  wrap.innerHTML = `<input id="tree-filter" type="text" placeholder="Filter files…" />`;
  sidebar.appendChild(wrap);
  const inp = wrap.querySelector('#tree-filter');
  function apply() {
    const q = inp.value.trim().toLowerCase();
    const nodes = tree.querySelectorAll('.node');
    if (!q) { nodes.forEach((n) => { n.style.display = ''; }); return; }
    const showSet = new Set();
    nodes.forEach((n) => {
      const name = (n.dataset.name || n.textContent || '').toLowerCase();
      const isFile = n.classList.contains('file') || n.classList.contains('image');
      if (isFile && name.includes(q)) {
        showSet.add(n);
        let p = n.parentElement;
        while (p && p !== tree) {
          if (p.classList?.contains('node')) showSet.add(p);
          p = p.parentElement;
        }
      }
    });
    nodes.forEach((n) => { n.style.display = showSet.has(n) ? '' : 'none'; });
  }
  inp.addEventListener('input', apply);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) {
      // Don't conflict with quick-switcher (Ctrl-P opens quick switcher); use Ctrl+L for tree filter focus
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault(); inp.focus(); inp.select();
    }
  });
}

// ---------------------------------------------------------------------------
// 9) Drafts recovery prompt (called from openFile hook)
// ---------------------------------------------------------------------------
async function maybePromptDraftRecovery(filePath, currentFileText) {
  try {
    const draft = await api.draftGet(filePath);
    if (!draft) return null;
    if (!draft.content || draft.content === currentFileText) {
      // No useful draft, clean it up
      api.draftClear(filePath).catch(() => {});
      return null;
    }
    return new Promise((resolve) => {
      const t = window.toast.warn(
        `Recover unsaved changes from ${new Date(draft.savedAt).toLocaleString()}?`,
        {
          duration: 0,
          actionLabel: 'Recover',
          action: () => resolve(draft.content),
        }
      );
      // After 30s assume "no"
      setTimeout(() => { t.dismiss(); resolve(null); }, 30000);
    });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 10) Topbar gear + about + print buttons (and update check on boot)
// ---------------------------------------------------------------------------
function installTopbarButtons() {
  const status = document.getElementById('status');
  if (!status) return;
  const mk = (id, title, label, handler) => {
    const b = document.createElement('button');
    b.id = id; b.title = title; b.textContent = label;
    b.className = 'topbar-btn';
    b.onclick = handler;
    return b;
  };
  // Insert before save-btn
  const saveBtn = document.getElementById('save-btn');
  const refs = [];
  refs.push(mk('print-btn', 'Print to PDF', '🖨', async () => {
    try { window.MDVAnalytics?.track('file.print-pdf'); } catch {}
    const cf = document.getElementById('current-file')?.textContent || 'document';
    const base = cf.split(/[\\\/]/).pop().replace(/\.(md|markdown)$/i, '');
    const r = await api.printToPdf(base || 'document');
    if (r.ok) window.toast.success('Saved PDF'); else if (!r.canceled) window.toast.error(r.error || 'Print failed');
  }));
  refs.push(mk('comments-overlay-btn', 'Cycle comment overlay (inline → gutter → off)', '💬', cycleCommentOverlay));
  refs.push(mk('insights-btn', 'Usage insights', '📊', () => {
    try { window.MDVInsights?.open(); }
    catch (e) { window.toast?.error?.('Insights failed to open'); console.warn(e); }
  }));
  refs.push(mk('manual-btn', 'Manual', '📖', () => { try { window.MDVAnalytics?.track('manual.open'); } catch {} openManual(); }));
  refs.push(mk('settings-btn', 'Settings', '⚙', () => { try { window.MDVAnalytics?.track('settings.open'); } catch {} openSettings(); }));
  refs.push(mk('about-btn', 'About', 'ⓘ', () => { try { window.MDVAnalytics?.track('about.open'); } catch {} openAbout(); }));
  refs.forEach((b) => status.insertBefore(b, saveBtn));
}

// ---------------------------------------------------------------------------
// 11) Replace native confirm/alert globally with toasts where safe
// ---------------------------------------------------------------------------
// (We don't replace confirm() because it's used for destructive ops where
// blocking is desired. We do shim alert -> toast.error for non-blocking UX.)
const _origAlert = window.alert;
window.alert = (m) => { try { window.toast.error(String(m)); } catch { _origAlert(m); } };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const s = await loadSettings();
  // Default to vscodeShell on for first run
  if (s.vscodeShell === undefined) await saveSettings({ vscodeShell: true });
  applyShellPrefs(_settings || s);
  installFindBar();
  installTreeFilter();
  installTopbarButtons();
  // Toast bridge from main process
  try { api.onToast?.((t) => { if (t?.msg) (window.toast[t.kind] || window.toast.info)(t.msg); }); } catch {}
  // Auto-check updates (delayed so it doesn't block first paint)
  if (s.autoUpdateCheck && s.updateManifestUrl) {
    setTimeout(() => runUpdateCheck(false), 4000);
  }
}

// Expose helpers for renderer.js to call
window.MDV13 = {
  loadSettings, saveSettings, openSettings, openAbout,
  maybePromptDraftRecovery, runUpdateCheck,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
