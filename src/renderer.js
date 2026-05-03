// src/renderer.js — bundled with esbuild
import './ui13.js';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/core';
import { undo as pmUndo, redo as pmRedo, undoDepth, redoDepth } from '@milkdown/kit/prose/history';
import {
  createCrepeMrsfFeature,
  createCrepeMrsfToolbarConfig,
  getCrepeMrsfController,
} from '@mrsf/milkdown-mrsf';
import { marked as _markedLib } from 'marked';
const _marked = _markedLib;
try { window._marked = _markedLib; } catch {}
function mdToHtml(s) {
  try { return _marked.parse(String(s || ''), { breaks: true, gfm: true }); }
  catch { return escHtml(String(s || '')).replace(/\n/g, '<br>'); }
}
// Theme CSS is loaded via <link id="theme-css"> in index.html and
// swappable via the toolbar dropdown (see installThemeSwitcher below).

// ---- Observability bootstrap (mirrors CSU-Compass) ---------------------
const obs = window.obs;
function obsSend(e) {
  try { void obs?.emit(e); } catch { /* never throw from telemetry */ }
}
window.addEventListener('error', (ev) => {
  obsSend({
    level: 'error',
    type: 'renderer.window.error',
    message: ev.message || String(ev.error),
    stack: ev.error?.stack,
    context: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
  });
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  obsSend({
    level: 'error',
    type: 'renderer.unhandled_rejection',
    message: r?.message || String(ev.reason),
    stack: r?.stack,
  });
});
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    try {
      const msg = args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
        .join(' ');
      const stack = args.find((a) => a instanceof Error)?.stack;
      obsSend({
        level: level === 'error' ? 'error' : 'warn',
        type: `renderer.console.${level}`,
        message: msg,
        stack,
      });
    } catch { /* swallow */ }
  };
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
obsSend({ level: 'info', type: 'renderer.session.start', message: 'renderer ready' });

// ---- Feature flags (set by main via window.__MDV_FLAGS__) -----------------
// Each defaults to OFF. Toggle from the OS shell with MDV_F_TREE=1 etc.
const FLAGS = window.__MDV_FLAGS__ || { tree: false, editor: false, comments: false, changes: false };
obsSend({ level: 'info', type: 'renderer.flags', message: 'feature flags', context: FLAGS });
// --------------------------------------------------------------------------

// ---- Theme switcher (custom dropdown — avoids native <select> popup
// which crashes some EDR-hardened Windows machines) ----------------------
(function installThemeSwitcher() {
  const link = document.getElementById('theme-css');
  const btn = document.getElementById('theme-button');
  const menu = document.getElementById('theme-menu');
  const label = document.getElementById('theme-button-label');
  if (!link || !btn || !menu || !label) return;
  const KEY = 'mdv.theme';
  const labelFor = (v) => {
    const li = menu.querySelector(`li[data-value="${v}"]`);
    return li ? li.textContent : v;
  };
  const applyTheme = (t) => {
    link.href = `./dist/themes/${t}.css`;
    label.textContent = labelFor(t);
    localStorage.setItem(KEY, t);
    menu.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('selected', li.dataset.value === t);
    });
  };
  const saved = localStorage.getItem(KEY) || 'frame-dark';
  applyTheme(saved);

  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]');
    if (!li) return;
    const t = li.dataset.value;
    applyTheme(t);
    obsSend({ level: 'info', type: 'renderer.theme.change', message: t });
    close();
  });
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
})();
// ------------------------------------------------------------------------
// ------------------------------------------------------------------------

const tree = document.getElementById('tree');
const logEl = document.getElementById('log');
const pickBtn = document.getElementById('pick-folder');
const rootPathEl = document.getElementById('root-path');
const editorEl = document.getElementById('editor');
const currentFileEl = document.getElementById('current-file');
const dirtyDot = document.getElementById('dirty-dot');
const saveStateEl = document.getElementById('save-state');
const saveBtn = document.getElementById('save-btn');
const clearLogBtn = document.getElementById('clear-log');
const commentCountEl = document.getElementById('comment-count');
const reanchorBtn = document.getElementById('reanchor-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');

const api = window.api;

let currentFile = null;
let currentFileDir = '';
let crepe = null;
let dirty = false;
let saveTimer = null;
let author = 'You (local)';

// ---- Image embedding helpers ---------------------------------------------
// Resolve a relative URL (e.g. "attachments/foo.png" or "../img/bar.jpg")
// against the open document's directory and return a file:// URL the
// Chromium renderer can load. Pure string ops — no IPC, runs synchronously
// from Crepe's proxyDomURL hook.
function _joinDocPath(baseDir, rel) {
  const baseParts = String(baseDir || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const relParts = String(rel || '').replace(/\\/g, '/').split('/');
  for (const seg of relParts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { baseParts.pop(); continue; }
    baseParts.push(seg);
  }
  return baseParts.join('/');
}
function resolveImageUrl(rel) {
  if (!rel) return rel;
  if (/^(https?:|data:|blob:|file:|mdv-img:)/i.test(rel)) return rel;
  if (!currentFileDir) return rel;
  // Drop a leading "./" but preserve absolute "/abs" paths
  const cleaned = rel.replace(/^\.\//, '');
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('/')) {
    return 'file:///' + cleaned.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  return 'file:///' + _joinDocPath(currentFileDir, cleaned);
}
async function uploadImageFile(file) {
  if (!currentFile) throw new Error('No file open');
  if (!file) throw new Error('No image file');
  const buf = await file.arrayBuffer();
  const r = await api.saveImage(currentFile, buf, file.name || 'image', file.type || '');
  if (!r?.ok) throw new Error(r?.error || 'image save failed');
  return r.relPath;
}
// Compute a relative path from currentFileDir to absImagePath. Returns POSIX-style.
function relativeFromDoc(absImagePath) {
  if (!absImagePath) return absImagePath;
  if (!currentFileDir) return 'file:///' + String(absImagePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const fromParts = norm(currentFileDir).split('/');
  const toParts = norm(absImagePath).split('/');
  // Drives differ on Windows → fall back to file:// absolute
  if (fromParts[0] && toParts[0] && fromParts[0].toLowerCase() !== toParts[0].toLowerCase()) {
    return 'file:///' + norm(absImagePath).replace(/^\/+/, '');
  }
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i].toLowerCase() === toParts[i].toLowerCase()) i++;
  const ups = fromParts.length - i;
  const rel = '../'.repeat(ups) + toParts.slice(i).join('/');
  return rel || toParts[toParts.length - 1];
}
function insertImageAtCursor(src, alt) {
  if (!crepe) return false;
  try {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const schema = view.state.schema;
      const imgType = schema.nodes.image || schema.nodes.imageBlock || schema.nodes['image-block'];
      if (!imgType) {
        // Last-resort: insert as markdown text
        const text = `![${alt || ''}](${src})`;
        view.dispatch(view.state.tr.insertText(text));
        return;
      }
      const node = imgType.create({ src, alt: alt || '', title: alt || '' });
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      view.focus();
    });
    return true;
  } catch (err) {
    console.warn('insertImageAtCursor failed', err);
    return false;
  }
}

// Bind paste + drop on the editor host *once*. Handlers read `currentFile`
// at call time, so they keep working as the user opens different docs.
let _imgIoBound = false;
function bindEditorImageIo() {
  if (_imgIoBound || !editorEl) return;
  _imgIoBound = true;
  // Only hijack paste/drop when the user is interacting with the actual
  // ProseMirror surface — never inside MRSF comment popups, toolbars, etc.
  const inProseMirror = (target) => {
    try { return !!(target && target.closest && target.closest('.ProseMirror')); }
    catch { return false; }
  };
  editorEl.addEventListener('paste', async (e) => {
    if (!currentFile || !crepe) return;
    if (!inProseMirror(e.target)) return;
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const imgs = [];
    for (const it of items) {
      if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (!imgs.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of imgs) {
      try {
        const rel = await uploadImageFile(f);
        insertImageAtCursor(rel, f.name?.replace(/\.[^.]+$/, '') || '');
      } catch (err) { console.warn('paste image failed', err); }
    }
  }, true);
  editorEl.addEventListener('drop', async (e) => {
    if (!currentFile || !crepe) return;
    if (!inProseMirror(e.target)) return;
    // Tree-image drag → insert reference (don't copy file)
    const treeRaw = e.dataTransfer?.getData('application/x-mdv-tree');
    if (treeRaw) {
      try {
        const drag = JSON.parse(treeRaw);
        if (drag?.type === 'image' && drag.path) {
          e.preventDefault(); e.stopPropagation();
          const rel = relativeFromDoc(drag.path);
          const alt = (drag.name || '').replace(/\.[^.]+$/, '');
          insertImageAtCursor(rel, alt);
          return;
        }
      } catch {}
    }
    const files = Array.from(e.dataTransfer?.files || []).filter(f => (f.type || '').startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of files) {
      try {
        const rel = await uploadImageFile(f);
        insertImageAtCursor(rel, f.name?.replace(/\.[^.]+$/, '') || '');
      } catch (err) { console.warn('drop image failed', err); }
    }
  }, true);
  // Block default browser navigation on dragover so drop fires.
  editorEl.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types || [];
    if ((types.includes('Files') || types.includes('application/x-mdv-tree')) && inProseMirror(e.target)) {
      e.preventDefault();
    }
  });

  // Display-layer src rewrite — every time Crepe inserts an <img> with a
  // relative src, swap the rendered DOM src to a file:// URL so it loads.
  // The markdown on disk and the ProseMirror model both keep the relative
  // path. Pure DOM read/write — never re-renders the editor, never loops.
  const REWRITTEN = '__mdvAbsSrc';
  const fixImg = (img) => {
    try {
      const orig = img.getAttribute('src') || '';
      if (!orig) return;
      // Remember original so we can re-evaluate after openFile changes dir.
      let originalRel = img[REWRITTEN];
      if (!originalRel) {
        if (/^(https?:|data:|blob:|file:|mdv-img:)/i.test(orig)) return;
        originalRel = orig;
        img[REWRITTEN] = orig;
      }
      const want = resolveImageUrl(originalRel);
      if (want && want !== img.getAttribute('src')) {
        img.setAttribute('src', want);
      }
    } catch {}
  };
  const scan = (root) => {
    if (!root) return;
    if (root.tagName === 'IMG') return fixImg(root);
    if (root.querySelectorAll) {
      const imgs = root.querySelectorAll('img');
      for (const img of imgs) fixImg(img);
    }
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
        fixImg(m.target);
      } else if (m.type === 'childList') {
        for (const n of m.addedNodes) scan(n);
      }
    }
  });
  obs.observe(editorEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  // Initial sweep in case images were already in DOM by the time we attached.
  scan(editorEl);
}
bindEditorImageIo();

// ---- Per-path event subscriptions (driven by main's fs-event broadcast) ----
const watchers = new Map(); // path -> Set<callback>
if (FLAGS.changes) {
  api.onFsEvent((payload) => {
    const set = watchers.get(payload.path);
    if (set) for (const cb of set) { try { cb(payload); } catch {} }
    addLog(payload);
  });
  api.onTreeDirty(() => {
    clearTimeout(window._treeRefresh);
    window._treeRefresh = setTimeout(refreshTree, 400);
  });
}

// Belt-and-braces: refresh the tree whenever the window regains focus, in case
// the chokidar watcher missed an event (OneDrive sync, network shares, etc.).
window.addEventListener('focus', () => {
  clearTimeout(window._treeRefresh);
  window._treeRefresh = setTimeout(() => { try { refreshTree(); } catch {} }, 200);
});

function subscribePath(p, cb) {
  let set = watchers.get(p);
  if (!set) { set = new Set(); watchers.set(p, set); }
  set.add(cb);
  return () => { set.delete(cb); if (!set.size) watchers.delete(p); };
}

// ---- Host adapter for @mrsf/milkdown-mrsf ----
function makeHost(mdPath) {
  return {
    async getDocumentText() { return api.readFile(mdPath); },
    async getDocumentPath() { return mdPath; },
    async discoverSidecar() { const r = await api.readSidecar(mdPath); return r.path; },
    async readSidecar(_sidecarPath) {
      const r = await api.readSidecar(mdPath);
      return r.doc;
    },
    async writeSidecar(_sidecarPath, doc) {
      if (!doc || !doc.comments || !doc.comments.length) {
        await api.deleteSidecar(mdPath);
      } else {
        await api.writeSidecar(mdPath, doc);
      }
      updateCommentCountFromDoc(doc);
      try { if (typeof renderComments === 'function') renderComments(doc, mdPath); } catch (_) {}
    },
    watchDocument(_resourceId, onChange) {
      return subscribePath(mdPath, (ev) => { if (!ev.isSidecar) onChange(); });
    },
    watchSidecar(sidecarPath, onChange) {
      // Sidecar may not exist yet; subscribe to both possible paths.
      const candidates = sidecarPath
        ? [sidecarPath]
        : ['.review.yaml', '.review.yml', '.review.json'].map(ext =>
            mdPath.replace(/\.(md|markdown)$/i, '') + ext);
      const unsubs = candidates.map(p => subscribePath(p, () => onChange()));
      return () => unsubs.forEach(u => u());
    },
  };
}

// ---- Tree + activity log ----
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function stripMd(name) { return name.replace(/\.(md|markdown)$/i, ''); }

function renderTree(node, container) {
  if (node.type === 'dir') {
    const wrap = document.createElement('div');
    wrap.dataset.path = node.path;
    wrap.dataset.type = 'dir';
    const head = document.createElement('div');
    head.className = 'node dir open';
    head.dataset.path = node.path;
    head.dataset.type = 'dir';
    head.dataset.name = node.name;
    head.draggable = true;
    head.innerHTML = `<span class="caret">▶</span><svg class="ico-folder" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 3a1 1 0 0 1 1-1h3.379a1 1 0 0 1 .707.293l1.207 1.207A1 1 0 0 0 8.5 3.793h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3z"/></svg><span class="dir-name">${escapeHtml(node.name)}</span><button class="dir-add" title="New file in ${escapeHtml(node.name)}">＋</button>`;
    const childWrap = document.createElement('div');
    childWrap.className = 'children';
    head.onclick = (e) => {
      if (e.target.closest('.dir-add')) return;
      head.classList.toggle('open');
      childWrap.classList.toggle('collapsed', !head.classList.contains('open'));
    };
    head.querySelector('.dir-add').onclick = (e) => {
      e.stopPropagation();
      head.classList.add('open');
      childWrap.classList.remove('collapsed');
      startInlineCreate(childWrap, node.path, 'file');
    };
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e, { type: 'dir', path: node.path, name: node.name, headEl: head, childWrap });
    });
    attachTreeDragHandlers(head, { type: 'dir', path: node.path, name: node.name });
    wrap.appendChild(head); wrap.appendChild(childWrap);
    container.appendChild(wrap);
    for (const c of node.children) renderTree(c, childWrap);
  } else if (node.type === 'image') {
    const item = document.createElement('div');
    item.className = 'node image';
    item.dataset.path = node.path;
    item.dataset.type = 'image';
    item.dataset.name = node.name;
    item.draggable = true;
    item.title = node.path;
    item.innerHTML = `🖼 <span class="file-name">${escapeHtml(node.name)}</span>`;
    item.onclick = () => openLightbox(node.path);
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e, { type: 'image', path: node.path, name: node.name, itemEl: item });
    });
    attachTreeDragHandlers(item, { type: 'image', path: node.path, name: node.name });
    container.appendChild(item);
  } else {
    const item = document.createElement('div');
    item.className = 'node file';
    item.dataset.path = node.path;
    item.dataset.type = 'file';
    item.dataset.name = node.name;
    item.draggable = true;
    const badge = node.hasComments ? ' <span class="cbadge" title="Has Sidemark comments">💬</span>' : '';
    const display = stripMd(node.name);
    item.innerHTML = `📄 <span class="file-name">${escapeHtml(display)}</span>${badge}`;
    item.onclick = () => openFile(node.path);
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e, { type: 'file', path: node.path, name: node.name, itemEl: item });
    });
    attachTreeDragHandlers(item, { type: 'file', path: node.path, name: node.name });
    container.appendChild(item);
  }
}

// ---- Tree drag & drop -----------------------------------------------------
function attachTreeDragHandlers(el, info) {
  el.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    // V1.3: Alt+drag = drag-out to OS / other apps
    if (e.altKey && info.type !== 'dir' && api.startDrag) {
      e.preventDefault();
      try { api.startDrag(info.path); } catch {}
      return;
    }
    const payload = JSON.stringify({ source: 'mdv-tree', ...info });
    e.dataTransfer.setData('application/x-mdv-tree', payload);
    e.dataTransfer.setData('text/plain', info.path);
    e.dataTransfer.effectAllowed = 'copyMove';
    el.classList.add('drag-source');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('drag-source');
    document.querySelectorAll('.node.drop-target').forEach(n => n.classList.remove('drop-target'));
  });
  // Only directory rows accept drops (move into folder)
  if (info.type === 'dir') {
    el.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types || [];
      if (!types.includes('application/x-mdv-tree')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('drop-target');
      const raw = e.dataTransfer?.getData('application/x-mdv-tree');
      if (!raw) return;
      e.preventDefault(); e.stopPropagation();
      let drag; try { drag = JSON.parse(raw); } catch { return; }
      if (!drag?.path || drag.path === info.path) return;
      // Don't drop a folder into itself or its own descendant
      const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
      if (norm(info.path).startsWith(norm(drag.path) + (drag.path.includes('\\') ? '\\' : '/'))) return;
      const newPath = window.__path_join(info.path, drag.name);
      if (norm(newPath) === norm(drag.path)) return;
      const r = await api.renamePath(drag.path, newPath);
      if (!r?.ok) {
        alert('Move failed: ' + (r?.error || 'unknown'));
        return;
      }
      await refreshTree();
    });
  }
}

// ---- Inline create / rename ----------------------------------------------
function startInlineCreate(parentEl, parentDirAbs, kind /* 'file'|'dir' */) {
  const row = document.createElement('div');
  row.className = 'node ' + (kind === 'dir' ? 'dir open' : 'file');
  const ico = kind === 'dir'
    ? '<span class="caret">▶</span><svg class="ico-folder" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 3a1 1 0 0 1 1-1h3.379a1 1 0 0 1 .707.293l1.207 1.207A1 1 0 0 0 8.5 3.793h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3z"/></svg>'
    : '📄 ';
  row.innerHTML = ico;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.placeholder = kind === 'dir' ? 'New folder' : 'New file';
  row.appendChild(input);
  parentEl.prepend(row);
  input.focus();

  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const name = input.value.trim();
    row.remove();
    if (!commit || !name) return;
    if (kind === 'dir') {
      const target = window.__path_join(parentDirAbs, name);
      const res = await api.createFolder(target);
      if (!res?.ok) { alert('Could not create folder: ' + (res?.error || 'unknown')); return; }
      await refreshTree();
    } else {
      const res = await api.createMdFile({ root: localStorage.getItem('lastFolder'), absPath: window.__path_join(parentDirAbs, name) });
      if (res?.canceled) return;
      if (!res?.ok) { alert('Could not create file: ' + (res?.error || 'unknown')); return; }
      await refreshTree();
      if (typeof openFile === 'function') openFile(res.path);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function startInlineRename(rowEl, currentPath, currentName, isDir) {
  const display = isDir ? currentName : stripMd(currentName);
  const labelEl = rowEl.querySelector(isDir ? '.dir-name' : '.file-name');
  if (!labelEl) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.value = display;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const newName = input.value.trim();
    const restoreName = (txt) => {
      const span = document.createElement('span');
      span.className = isDir ? 'dir-name' : 'file-name';
      span.textContent = txt;
      input.replaceWith(span);
    };
    if (!commit || !newName || newName === display) { restoreName(display); return; }
    const fullNew = isDir ? newName : (/\.(md|markdown)$/i.test(newName) ? newName : newName + '.md');
    const dir = currentPath.replace(/[\\\/][^\\\/]+$/, '');
    const newPath = window.__path_join(dir, fullNew);
    const res = await api.renamePath(currentPath, newPath);
    if (!res?.ok) { alert('Rename failed: ' + (res?.error || 'unknown')); restoreName(display); return; }
    await refreshTree();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Path join helper (works with Win backslashes)
window.__path_join = (a, b) => {
  if (!a) return b;
  if (/[\\\/]$/.test(a)) return a + b;
  const sep = a.includes('\\') ? '\\' : '/';
  return a + sep + b;
};

// ---- Lightbox -------------------------------------------------------------
const lightboxEl = document.getElementById('lightbox');
const lbImg = lightboxEl?.querySelector('.lb-img');
const lbCaption = lightboxEl?.querySelector('.lb-caption');
const lbStage = lightboxEl?.querySelector('.lb-stage');
const lbZoomLabel = lightboxEl?.querySelector('.lb-zoom-label');
let lbZoom = 1, lbFitMode = true;
function setLbZoom(z, opts) {
  lbZoom = Math.max(0.1, Math.min(20, z));
  lbFitMode = !!opts?.fit;
  if (!lbImg) return;
  if (lbFitMode) {
    lbImg.classList.remove('zoom-free');
    lbImg.style.transform = '';
  } else {
    lbImg.classList.add('zoom-free');
    lbImg.style.transform = `scale(${lbZoom})`;
  }
  if (lbZoomLabel) lbZoomLabel.textContent = lbFitMode ? 'Fit' : Math.round(lbZoom * 100) + '%';
}
function openLightbox(srcOrUrl, caption) {
  if (!lightboxEl || !lbImg) return;
  let url = srcOrUrl;
  if (typeof url === 'string' && !/^(https?:|data:|blob:|file:|mdv-img:)/i.test(url)) {
    // Treat as absolute filesystem path
    url = 'file:///' + url.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  lbImg.src = url;
  if (lbCaption) lbCaption.textContent = caption || (typeof srcOrUrl === 'string' ? srcOrUrl : '');
  lightboxEl.classList.remove('hidden');
  lightboxEl.setAttribute('aria-hidden', 'false');
  setLbZoom(1, { fit: true });
}
function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.classList.add('hidden');
  lightboxEl.setAttribute('aria-hidden', 'true');
  if (lbImg) lbImg.src = '';
}
if (lightboxEl) {
  lightboxEl.querySelector('.lb-close').onclick = closeLightbox;
  lightboxEl.querySelector('.lb-zoom-in').onclick = () => setLbZoom((lbFitMode ? 1 : lbZoom) * 1.25);
  lightboxEl.querySelector('.lb-zoom-out').onclick = () => setLbZoom((lbFitMode ? 1 : lbZoom) / 1.25);
  lightboxEl.querySelector('.lb-zoom-fit').onclick = () => setLbZoom(1, { fit: true });
  lightboxEl.querySelector('.lb-zoom-100').onclick = () => setLbZoom(1);
  lbStage.addEventListener('wheel', (e) => {
    if (lightboxEl.classList.contains('hidden')) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setLbZoom((lbFitMode ? 1 : lbZoom) * delta);
  }, { passive: false });
  // Click outside image closes
  lbStage.addEventListener('click', (e) => {
    if (e.target === lbStage) closeLightbox();
  });
  // Drag-to-pan when zoomed
  let panStart = null;
  lbStage.addEventListener('mousedown', (e) => {
    if (lbFitMode) return;
    panStart = { x: e.clientX, y: e.clientY, sl: lbStage.scrollLeft, st: lbStage.scrollTop };
    lbStage.classList.add('is-panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panStart) return;
    lbStage.scrollLeft = panStart.sl - (e.clientX - panStart.x);
    lbStage.scrollTop = panStart.st - (e.clientY - panStart.y);
  });
  window.addEventListener('mouseup', () => { panStart = null; lbStage.classList.remove('is-panning'); });
  window.addEventListener('keydown', (e) => {
    if (lightboxEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setLbZoom((lbFitMode ? 1 : lbZoom) * 1.25); }
    else if (e.key === '-') { e.preventDefault(); setLbZoom((lbFitMode ? 1 : lbZoom) / 1.25); }
    else if (e.key === '0') { e.preventDefault(); setLbZoom(1, { fit: true }); }
  });
  // Click any <img> inside the editor host opens lightbox
  document.addEventListener('click', (e) => {
    const img = e.target?.closest && e.target.closest('img');
    if (!img) return;
    if (!img.closest('#editor-host')) return;
    if (img.closest('.cmt-modal')) return;
    e.preventDefault();
    openLightbox(img.currentSrc || img.src, img.alt || '');
  }, true);
}


// ---- Context menu --------------------------------------------------------
let _ctxMenu = null;
function showCtxMenu(ev, ctx) {
  hideCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [];
  if (ctx.type === 'image') {
    items.push({ label: 'Open (zoom)', fn: () => openLightbox(ctx.path, ctx.name) });
    items.push({ label: 'Open in Explorer', fn: () => api.showInExplorer(ctx.path) });
    items.push({ label: 'Rename', fn: () => startInlineRename(ctx.itemEl, ctx.path, ctx.name, false) });
    items.push({ sep: true });
    items.push({ label: 'Delete', danger: true, fn: async () => {
      if (!confirm(`Move "${ctx.name}" to Trash?`)) return;
      const r = await api.deletePath(ctx.path);
      if (!r?.ok) alert('Delete failed: ' + r?.error);
      await refreshTree();
    }});
  } else if (ctx.type === 'dir') {
    items.push({ label: '＋ New file', fn: () => {
      ctx.headEl.classList.add('open');
      ctx.childWrap.classList.remove('collapsed');
      startInlineCreate(ctx.childWrap, ctx.path, 'file');
    }});
    items.push({ label: '＋ New folder', fn: () => {
      ctx.headEl.classList.add('open');
      ctx.childWrap.classList.remove('collapsed');
      startInlineCreate(ctx.childWrap, ctx.path, 'dir');
    }});
    items.push({ sep: true });
    items.push({ label: 'Open in Explorer', fn: () => api.showInExplorer(ctx.path) });
    items.push({ label: 'Rename', fn: () => startInlineRename(ctx.headEl, ctx.path, ctx.name, true) });
    items.push({ label: 'Delete folder', danger: true, fn: async () => {
      if (!confirm(`Move "${ctx.name}" and its contents to Trash?`)) return;
      const r = await api.deletePath(ctx.path);
      if (!r?.ok) alert('Delete failed: ' + r?.error);
      await refreshTree();
    }});
  } else {
    items.push({ label: 'Open', fn: () => openFile(ctx.path) });
    items.push({ label: 'Open in Explorer', fn: () => api.showInExplorer(ctx.path) });
    items.push({ label: 'Rename', fn: () => startInlineRename(ctx.itemEl, ctx.path, ctx.name, false) });
    items.push({ sep: true });
    items.push({ label: 'Delete', danger: true, fn: async () => {
      if (!confirm(`Move "${stripMd(ctx.name)}" to Trash?`)) return;
      const r = await api.deletePath(ctx.path);
      if (!r?.ok) alert('Delete failed: ' + r?.error);
      await refreshTree();
    }});
  }
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.textContent = it.label;
    el.onclick = () => { hideCtxMenu(); try { it.fn(); } catch (e) { console.error(e); } };
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // Position
  const rect = { x: ev.clientX, y: ev.clientY };
  menu.style.left = rect.x + 'px';
  menu.style.top = rect.y + 'px';
  // Clamp to viewport
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 4) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 4) + 'px';
  });
  _ctxMenu = menu;
}
function hideCtxMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}
document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.node')) hideCtxMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    const active = document.querySelector('.node.file.active');
    if (active && active.dataset.path) {
      const name = active.dataset.path.split(/[\\\/]/).pop();
      startInlineRename(active, active.dataset.path, name, false);
    }
  }
});

function setActive(p) {
  document.querySelectorAll('.node.file').forEach(n => n.classList.toggle('active', n.dataset.path === p));
  document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
  if (p) {
    const el = document.querySelector(`.node[data-path="${(window.CSS && CSS.escape) ? CSS.escape(p) : p}"]`);
    if (el) el.classList.add('selected');
  }
}

// V1.3: Delete key on tree → delete selected file/folder with confirm
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Delete') return;
  if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  const sel = document.querySelector('.node.selected');
  if (!sel || !sel.dataset.path) return;
  const p = sel.dataset.path;
  const name = p.split(/[\\\/]/).pop();
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    const r = await api.deletePath(p);
    if (r?.ok === false) { window.toast?.error?.(r.error || 'Delete failed'); return; }
    window.toast?.success?.(`Deleted ${name}`);
    await refreshTree();
  } catch (err) { window.toast?.error?.(String(err?.message || err)); }
});

function addLog(payload) {
  const { event, path: p, isSidecar, time } = payload;
  const li = document.createElement('li');
  const t = new Date(time);
  const tag = isSidecar ? `<span class="kind sidecar">sidecar</span>` : '';
  li.innerHTML = `<span class="ev ${event}">${event}</span>${tag}<span class="fname"></span><span class="ts">${t.toLocaleTimeString()}</span>`;
  li.querySelector('.fname').textContent = p.split(/[\\\/]/).pop();
  li.title = p;
  li.onclick = () => {
    if (event === 'removed') return;
    const target = isSidecar ? p.replace(/\.review\.(ya?ml|json)$/i, '.md') : p;
    openFile(target);
  };
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.removeChild(logEl.lastChild);
}

async function refreshTree() {
  const folder = localStorage.getItem('lastFolder');
  if (!folder) return;
  const data = await api.loadTree(folder);
  tree.innerHTML = '';
  renderTree(data, tree);
  setActive(currentFile);
}

// ---- File open + Crepe lifecycle ----
async function openFile(p) {
  if (!FLAGS.editor) {
    currentFile = p;
    currentFileEl.textContent = p + '  [editor disabled]';
    setActive(p);
    return;
  }
  // Autosave on file switch — never prompt. Flush any pending debounced save first.
  if (dirty) {
    clearTimeout(saveTimer);
    try { await saveFile(); } catch (e) { console.warn('[autosave] flush before switch failed', e); }
  }
  await destroyEditor();
  currentFile = p;
  currentFileDir = p.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  currentFileEl.textContent = p;
  currentFileEl.title = p;
  setActive(p);

  const md = await api.readFile(p);
  editorEl.innerHTML = '';

  const crepeOpts = { root: editorEl, defaultValue: md, featureConfigs: {} };
  if (FLAGS.comments) {
    const mrsfOptions = {
      resourceId: p,
      defaultAuthor: author,
      interactive: true,
      liveTracking: 'debounced',
      // Auto-persist on every comment mutation. defaultSave() writes via host.writeSidecar.
      onSaveRequest: async (req) => {
        // ReviewStore.save() throws "No sidecar path" because we never told it the
        // sidecar location. Bypass it and write directly via the host IPC.
        try {
          const doc = req?.state?.document;
          if (doc) await api.writeSidecar(p, doc);
        } catch (e) { console.warn('[mrsf] onSaveRequest direct write failed', e); }
      },
      onStateChange: (ev) => {
        const doc = ev?.state?.document;
        // 1) Persist FIRST — never let a render bug block disk writes.
        if (ev?.dirty && doc) {
          api.writeSidecar(p, doc)
            .then(t => console.log('[mrsf] wrote sidecar', t, 'comments:', doc.comments?.length))
            .catch(err => console.warn('[mrsf] direct save failed', err));
        }
        // 2) Then update UI (guarded).
        try {
          if (doc) {
            updateCommentCountFromDoc(doc);
            if (typeof renderComments === 'function') renderComments(doc, p);
          }
        } catch (e) { console.warn('[mrsf] render after save failed', e); }
      },
    };
    crepeOpts.featureConfigs.toolbar = createCrepeMrsfToolbarConfig(mrsfOptions);
    crepe = new Crepe(crepeOpts);
    const host = makeHost(p);
    crepe.addFeature(createCrepeMrsfFeature(host, mrsfOptions));
  } else {
    crepe = new Crepe(crepeOpts);
  }

  await crepe.create();

  if (FLAGS.changes) {
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (markdown === md) return;
        dirty = true;
        updateStatus();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveFile, 1500);
        // V1.3: autosave draft snapshot (separate from real save)
        try { api.draftSave(p, markdown); } catch {}
      });
    });
  }

  if (FLAGS.comments) {
    const sc = await api.readSidecar(p);
    updateCommentCountFromDoc(sc.doc);
  }
  // V1.3: persist last-opened file
  try { api.setLastFile({ path: p }); } catch {}
  // V1.3: clear any draft now that we've cleanly opened
  try { api.draftClear(p); } catch {}
  dirty = false; updateStatus();
}

async function destroyEditor() {
  if (!crepe) return;
  try { await crepe.destroy(); } catch {}
  crepe = null;
  editorEl.innerHTML = '';
}

async function saveFile() {
  if (!currentFile || !crepe) return;
  const md = crepe.getMarkdown();
  await api.writeFile(currentFile, md);
  dirty = false; updateStatus();
  // V1.3: clear draft after successful save
  try { api.draftClear(currentFile); } catch {}

  // Ask the MRSF controller to reanchor against the saved text.
  try {
    const ctrl = getCrepeMrsfController(crepe);
    if (ctrl?.save) await ctrl.save();
    else if (ctrl?.reanchor) await ctrl.reanchor();
  } catch (err) {
    console.warn('mrsf save/reanchor failed:', err);
  }
}

function updateStatus() {
  dirtyDot.classList.toggle('hidden', !dirty);
  saveStateEl.textContent = dirty ? 'unsaved' : 'saved';
  saveBtn.disabled = !dirty;
  updateUndoRedoButtons();
}

// ---- Undo / Redo ----
function withEditorView(fn) {
  if (!crepe) return null;
  try {
    return crepe.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
  } catch { return null; }
}
function doUndo() {
  withEditorView((view) => { pmUndo(view.state, view.dispatch); view.focus(); });
  updateUndoRedoButtons();
}
function doRedo() {
  withEditorView((view) => { pmRedo(view.state, view.dispatch); view.focus(); });
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  if (!undoBtn || !redoBtn) return;
  let uD = 0, rD = 0;
  withEditorView((view) => { uD = undoDepth(view.state); rD = redoDepth(view.state); });
  undoBtn.disabled = uD === 0;
  redoBtn.disabled = rD === 0;
}
if (undoBtn) undoBtn.onclick = doUndo;
if (redoBtn) redoBtn.onclick = doRedo;

// Global keyboard shortcuts — work even if focus is outside the editor
// (sidebar, comments rail, etc). The editor's internal Mod-Z still works
// when focus is inside ProseMirror; this just makes it work everywhere.
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  // Skip if focus is in an input/textarea/contenteditable other than ProseMirror
  // — let those handle their own undo. ProseMirror's own keymap takes priority
  // anyway when focused there.
  const t = e.target;
  const inProseMirror = !!(t && t.closest && t.closest('.ProseMirror'));
  if (!inProseMirror && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  } else if ((key === 'z' && e.shiftKey) || key === 'y') {
    e.preventDefault();
    doRedo();
  }
});

function updateCommentCountFromDoc(doc) {
  const all = doc?.comments || [];
  if (!all.length) {
    commentCountEl.textContent = '';
    commentCountEl.style.display = 'none';
    return;
  }
  const open = all.filter(c => !c.resolved).length;
  commentCountEl.textContent = `💬 ${open}/${all.length}`;
  commentCountEl.style.display = '';
}

// ---- Wiring ----
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); saveFile();
  }
});

// ---- Folder history + gallery ---------------------------------------------
const RECENTS_KEY = 'recentFolders';
const RECENTS_MAX = 12;

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // Migrate legacy single-folder key
  const legacy = localStorage.getItem('lastFolder');
  return legacy ? [{ path: legacy, opened_at: Date.now() }] : [];
}
function saveRecents(list) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
}
function pushRecent(folder) {
  const existing = loadRecents().find(r => r.path === folder);
  const list = loadRecents().filter(r => r.path !== folder);
  list.unshift({ path: folder, opened_at: Date.now(), label: existing?.label });
  saveRecents(list);
}
function setRecentLabel(folder, label) {
  const list = loadRecents();
  const r = list.find(x => x.path === folder);
  if (!r) return;
  const trimmed = (label || '').trim();
  if (trimmed) r.label = trimmed; else delete r.label;
  saveRecents(list);
}
function removeRecent(folder) {
  saveRecents(loadRecents().filter(r => r.path !== folder));
}
function recentDisplayName(r) { return r.label || basename(r.path); }
function basename(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  const d = Math.floor(s/86400);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

const recentsBtn = document.getElementById('recents-btn');
const recentsMenu = document.getElementById('recents-menu');
const homeBtn = document.getElementById('home-btn');
const galleryPanel = document.getElementById('gallery-panel');
const galleryGrid = document.getElementById('gallery-grid');
const gallerySort = document.getElementById('gallery-sort');
const galleryAdd = document.getElementById('gallery-add');
async function openGallery() {
  if (!galleryPanel) return;
  galleryPanel.classList.remove('hidden');
  await renderGallery();
}
function closeGallery() { if (galleryPanel) galleryPanel.classList.add('hidden'); }

function renderRecentsMenu() {
  const recents = loadRecents();
  recentsMenu.innerHTML = '';
  if (!recents.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No recent folders';
    recentsMenu.appendChild(li);
    return;
  }
  for (const r of recents) {
    const li = document.createElement('li');
    const name = recentDisplayName(r);
    li.innerHTML = `<span class="mi-name">${escapeHtml(name)}</span><span class="mi-path">${escapeHtml(r.path)}</span>`;
    li.onclick = () => { recentsMenu.classList.add('hidden'); loadRoot(r.path); };
    recentsMenu.appendChild(li);
  }
}
recentsBtn.onclick = (e) => {
  e.stopPropagation();
  const wasHidden = recentsMenu.classList.contains('hidden');
  if (wasHidden) renderRecentsMenu();
  recentsMenu.classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!recentsMenu.contains(e.target) && e.target !== recentsBtn) {
    recentsMenu.classList.add('hidden');
  }
});

const FOLDER_SVG = '<svg class="ico-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.5 3a1 1 0 0 1 1-1h3.379a1 1 0 0 1 .707.293l1.207 1.207A1 1 0 0 0 8.5 3.793h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3z"/></svg>';

async function renderGallery() {
  const recents = loadRecents();
  galleryGrid.innerHTML = '';

  // Add card first
  const addCard = document.createElement('div');
  addCard.className = 'gallery-card gc-add';
  addCard.innerHTML = `${FOLDER_SVG}<div>Add folder…</div>`;
  addCard.onclick = async () => {
    const folder = await api.pickFolder();
    if (folder) { closeGallery(); loadRoot(folder); }
  };
  galleryGrid.appendChild(addCard);

  // Fetch stats in parallel
  const stats = await Promise.all(recents.map(async r => {
    try { return await api.getFolderStats(r.path); } catch { return { exists: false }; }
  }));

  const enriched = recents.map((r, i) => ({
    ...r,
    ...stats[i],
    last_change_at: stats[i]?.lastModified || 0,
  }));

  const sortMode = gallerySort.querySelector('button.active')?.dataset.sort || 'opened';
  enriched.sort((a, b) => {
    if (sortMode === 'changed') return (b.last_change_at || 0) - (a.last_change_at || 0);
    if (sortMode === 'name') return recentDisplayName(a).localeCompare(recentDisplayName(b));
    return (b.opened_at || 0) - (a.opened_at || 0);
  });

  for (const r of enriched) {
    const card = document.createElement('div');
    card.className = 'gallery-card' + (r.exists ? '' : ' gc-missing');
    const count = r.exists ? `${r.mdCount} md` : '—';
    const displayName = recentDisplayName(r);
    const isCustomLabel = !!r.label;
    card.innerHTML = `
      <div class="gc-actions">
        <button class="gc-act gc-rename" title="Rename" aria-label="Rename">✎</button>
        <button class="gc-act gc-remove" title="Remove from list" aria-label="Remove">×</button>
      </div>
      <div class="gc-name">${FOLDER_SVG}<span class="gc-label">${escapeHtml(displayName)}</span></div>
      <div class="gc-path">${escapeHtml(r.path)}${isCustomLabel ? '' : ''}</div>
      <div class="gc-meta">
        <span class="gc-pill">${count}</span>
        <span>opened ${fmtAgo(r.opened_at)}</span>
        <span>changed ${fmtAgo(r.last_change_at)}</span>
      </div>`;
    card.onclick = (ev) => {
      if (ev.target.closest('.gc-actions') || ev.target.closest('.gc-label-edit')) return;
      if (r.exists) { closeGallery(); loadRoot(r.path); }
    };
    const renameBtn = card.querySelector('.gc-rename');
    renameBtn.onclick = (ev) => {
      ev.stopPropagation();
      startGalleryRename(card, r);
    };
    const removeBtn = card.querySelector('.gc-remove');
    removeBtn.onclick = (ev) => {
      ev.stopPropagation();
      removeRecent(r.path);
      renderGallery();
    };
    galleryGrid.appendChild(card);
  }
}

function startGalleryRename(card, r) {
  const labelSpan = card.querySelector('.gc-label');
  if (!labelSpan) return;
  const current = recentDisplayName(r);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gc-label-edit';
  input.value = current;
  input.spellcheck = false;
  labelSpan.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) {
      const v = input.value.trim();
      // Empty + previously had label → clear label (revert to basename)
      if (v && v !== basename(r.path)) setRecentLabel(r.path, v);
      else setRecentLabel(r.path, '');
    }
    renderGallery();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

homeBtn.onclick = openGallery;
if (galleryAdd) galleryAdd.onclick = async () => {
  const folder = await api.pickFolder();
  if (folder) { closeGallery(); loadRoot(folder); }
};
gallerySort.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (!b) return;
  gallerySort.querySelectorAll('button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  renderGallery();
});
// galleryOverlay removed — gallery is now an inline panel inside #editor-host.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGallery();
});

pickBtn.onclick = async () => {
  const folder = await api.pickFolder();
  if (folder) loadRoot(folder);
};

// ---- New document via toolbar --------------------------------------------
async function startTopLevelCreate(kind) {
  const root = localStorage.getItem('lastFolder');
  if (!root) { alert('Open a folder first.'); return; }
  // Use the tree root container as the parent — new node appears at top.
  startInlineCreate(tree, root, kind);
}

const newDocBtn = document.getElementById('new-doc');
if (newDocBtn) newDocBtn.onclick = () => startTopLevelCreate('file');
const newFolderBtn = document.getElementById('new-folder');
if (newFolderBtn) newFolderBtn.onclick = () => startTopLevelCreate('dir');

async function loadRoot(folder) {
  rootPathEl.textContent = folder;
  rootPathEl.title = folder;
  const data = await api.loadTree(folder);
  tree.innerHTML = '';
  renderTree(data, tree);
  localStorage.setItem('lastFolder', folder);
  pushRecent(folder);
}

clearLogBtn.onclick = () => { logEl.innerHTML = ''; };
saveBtn.onclick = saveFile;
reanchorBtn.onclick = async () => {
  if (!crepe) return;
  try {
    const ctrl = getCrepeMrsfController(crepe);
    if (ctrl?.reanchor) {
      await ctrl.reanchor({ updateText: true });
      const sc = await api.readSidecar(currentFile);
      updateCommentCountFromDoc(sc.doc);
    }
  } catch (e) { console.warn(e); }
};

// ---- Boot ----
(async () => {
  try {
    const u = await api.getUser();
    if (u?.name) author = u.email ? `${u.name} (${u.email})` : u.name;
    else if (u?.username) author = u.username;
  } catch {}
  if (FLAGS.tree) {
    const last = localStorage.getItem('lastFolder');
    if (last) await loadRoot(last);
    // V1.3: restore last-opened file
    try {
      const s = await api.getSettings();
      const lf = s?.lastFile?.path;
      if (lf && last && lf.toLowerCase().startsWith(String(last).toLowerCase())) {
        // Check it still exists before opening
        try { await api.readFile(lf); openFile(lf); } catch {}
      }
    } catch {}
  } else {
    rootPathEl.textContent = '[tree disabled]';
    pickBtn.disabled = true;
  }
  api.onOpenMdFromOs(async (p) => {
    if (!p) return;
    const dir = p.replace(/[\\/][^\\/]+$/, '');
    const currentRoot = rootPathEl.textContent;
    const inside = currentRoot && (p === currentRoot || p.toLowerCase().startsWith(String(currentRoot).toLowerCase().replace(/[\\/]+$/, '') + (currentRoot.includes('\\') ? '\\' : '/')));
    if (!inside) await loadRoot(dir);
    try { closeGallery(); } catch {}
    openFile(p);
  });
})();

// =========================================================================
// Wave 1: Find & Connect
// =========================================================================

// ---- Fuzzy match helper -------------------------------------------------
// Returns { score, ranges } if all chars in query appear in subject in order.
// Higher score = better match (consecutive chars + start-of-word bonuses).
function fuzzyMatch(subject, query) {
  if (!query) return { score: 1, ranges: [] };
  const sLower = subject.toLowerCase();
  const qLower = query.toLowerCase();
  let si = 0, qi = 0, score = 0, prevMatched = false;
  const ranges = [];
  while (si < sLower.length && qi < qLower.length) {
    if (sLower[si] === qLower[qi]) {
      let runLen = 0;
      const start = si;
      while (si < sLower.length && qi < qLower.length && sLower[si] === qLower[qi]) {
        const isStart = si === 0 || /[\s/\\._-]/.test(subject[si - 1]);
        score += isStart ? 8 : (prevMatched ? 4 : 2);
        si++; qi++; runLen++; prevMatched = true;
      }
      ranges.push([start, start + runLen]);
    } else {
      prevMatched = false;
      si++;
    }
  }
  if (qi < qLower.length) return null;
  // Penalty for total length
  score -= Math.floor(subject.length / 30);
  return { score, ranges };
}

function highlightRanges(text, ranges) {
  if (!ranges || !ranges.length) return escapeHtml(text);
  let out = '';
  let last = 0;
  for (const [a, b] of ranges) {
    out += escapeHtml(text.slice(last, a));
    out += '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
    last = b;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// ---- Quick Switcher (Ctrl-P) -------------------------------------------
const qsOverlay = document.getElementById('quickswitch-overlay');
const qsInput = document.getElementById('qs-input');
const qsResults = document.getElementById('qs-results');
let qsItems = [];
let qsActive = 0;

async function openQuickSwitcher() {
  if (!FLAGS.tree) return;
  qsItems = await api.listMdFiles();
  qsOverlay.classList.remove('hidden');
  qsInput.value = '';
  qsActive = 0;
  renderQs('');
  qsInput.focus();
}
function closeQuickSwitcher() { qsOverlay.classList.add('hidden'); }

function renderQs(q) {
  let matches;
  if (!q) {
    matches = qsItems.slice(0, 50).map(f => ({ f, ranges: [], score: 0 }));
  } else {
    matches = [];
    for (const f of qsItems) {
      const r = fuzzyMatch(f.rel, q);
      if (r) matches.push({ f, ranges: r.ranges, score: r.score });
    }
    matches.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, 50);
  }
  qsResults.innerHTML = '';
  matches.forEach((m, i) => {
    const li = document.createElement('li');
    if (i === qsActive) li.classList.add('active');
    li.innerHTML = `<span class="qs-name">${highlightRanges(m.f.name, m.ranges.filter(([a,b]) => a >= m.f.rel.length - m.f.name.length).map(([a,b]) => [a - (m.f.rel.length - m.f.name.length), b - (m.f.rel.length - m.f.name.length)]))}</span><span class="qs-dir">${escapeHtml(m.f.dir === '.' ? '' : m.f.dir)}</span>`;
    li.onclick = () => { closeQuickSwitcher(); openFile(m.f.path); };
    li.dataset.path = m.f.path;
    qsResults.appendChild(li);
  });
  if (!matches.length) {
    qsResults.innerHTML = '<li class="empty">No matches</li>';
  }
}

qsInput.addEventListener('input', () => { qsActive = 0; renderQs(qsInput.value); });
qsInput.addEventListener('keydown', (e) => {
  const items = qsResults.querySelectorAll('li[data-path]');
  if (e.key === 'ArrowDown') { e.preventDefault(); qsActive = Math.min(qsActive + 1, items.length - 1); renderQs(qsInput.value); items[qsActive]?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qsActive = Math.max(qsActive - 1, 0); renderQs(qsInput.value); items[qsActive]?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); items[qsActive]?.click(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeQuickSwitcher(); }
});

// ---- Full-text Search (Ctrl-Shift-F) -----------------------------------
const searchOverlay = document.getElementById('search-overlay');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchRegex = document.getElementById('search-regex');
const searchSidecars = document.getElementById('search-sidecars');
let searchTimer = null;

function openSearch() {
  if (!FLAGS.tree) return;
  searchOverlay.classList.remove('hidden');
  searchInput.focus();
  searchInput.select();
}
function closeSearch() { searchOverlay.classList.add('hidden'); }

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) { searchResults.innerHTML = ''; return; }
  searchResults.innerHTML = '<div class="sr-empty">Searching…</div>';
  const r = await api.searchText({ query: q, regex: searchRegex.checked, includeSidecars: searchSidecars.checked });
  if (r.error) { searchResults.innerHTML = `<div class="sr-empty">⚠ ${escapeHtml(r.error)}</div>`; return; }
  if (!r.results.length) { searchResults.innerHTML = '<div class="sr-empty">No matches.</div>'; return; }
  searchResults.innerHTML = '';
  let qRe;
  try { qRe = new RegExp(searchRegex.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch { qRe = null; }
  for (const fileResult of r.results) {
    const head = document.createElement('div');
    head.className = 'sr-file';
    head.innerHTML = `<span class="sr-kind ${fileResult.kind}">${fileResult.kind}</span><span>${escapeHtml(fileResult.rel)}</span><span class="sr-count">${fileResult.matches.length}</span>`;
    head.onclick = () => { closeSearch(); openFile(fileResult.file); };
    searchResults.appendChild(head);
    for (const m of fileResult.matches) {
      const row = document.createElement('div');
      row.className = 'sr-match';
      const snippet = qRe ? m.snippet.replace(qRe, (s) => `<mark>${escapeHtml(s)}</mark>`) : escapeHtml(m.snippet);
      row.innerHTML = `<span class="sr-line">${m.line}</span><span class="sr-text">${snippet}</span>`;
      row.onclick = () => { closeSearch(); openFile(fileResult.file); };
      searchResults.appendChild(row);
    }
  }
  if (r.truncated) {
    const t = document.createElement('div');
    t.className = 'sr-trunc';
    t.textContent = `Results truncated at ${r.total}. Refine your query for more.`;
    searchResults.appendChild(t);
  }
}

searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  else if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});
searchRegex.addEventListener('change', runSearch);
searchSidecars.addEventListener('change', runSearch);

// Global hotkeys
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault(); openQuickSwitcher();
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault(); openSearch();
  }
});
qsOverlay.addEventListener('click', (e) => { if (e.target === qsOverlay) closeQuickSwitcher(); });
searchOverlay.addEventListener('click', (e) => { if (e.target === searchOverlay) closeSearch(); });

// Rail collapse toggles
document.querySelectorAll('.rail-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.rail-section').classList.toggle('collapsed');
  });
});

// ---- Outline panel ------------------------------------------------------
const outlineBody = document.getElementById('outline-body');

function parseHeadings(md) {
  if (!md) return [];
  const out = [];
  const lines = md.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^```|^~~~/.test(L)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(L);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  }
  return out;
}

function renderOutline(md) {
  const headings = parseHeadings(md);
  outlineBody.innerHTML = '';
  if (!headings.length) {
    outlineBody.innerHTML = '<li class="empty">No headings</li>';
    return;
  }
  for (const h of headings) {
    const li = document.createElement('li');
    li.dataset.level = h.level;
    li.textContent = h.text;
    li.title = `H${h.level} · line ${h.line}`;
    li.onclick = () => scrollToHeading(h.text, h.level);
    outlineBody.appendChild(li);
  }
}

function scrollToHeading(text, level) {
  // Find the matching heading in the rendered editor DOM
  const sel = `h${level}`;
  const candidates = editorEl.querySelectorAll(sel);
  for (const el of candidates) {
    if (el.textContent.trim() === text) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.style.transition = 'background .8s';
      el.style.background = '#2d6cdf44';
      setTimeout(() => { el.style.background = ''; }, 800);
      return;
    }
  }
}

// ---- Backlinks panel ----------------------------------------------------
const backlinksBody = document.getElementById('backlinks-body');
const backlinksCount = document.getElementById('backlinks-count');

async function refreshBacklinks(filePath) {
  if (!filePath) { backlinksBody.innerHTML = ''; backlinksCount.textContent = ''; return; }
  const baseName = filePath.split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '');
  backlinksBody.innerHTML = '<li class="empty">Searching…</li>';
  const links = await api.findBacklinks(baseName);
  backlinksBody.innerHTML = '';
  backlinksCount.textContent = links.length ? String(links.length) : '';
  if (!links.length) {
    backlinksBody.innerHTML = '<li class="empty">No backlinks</li>';
    return;
  }
  for (const l of links) {
    for (const h of l.hits) {
      const li = document.createElement('li');
      li.title = `${l.rel}:${h.line}`;
      li.innerHTML = `${escapeHtml(l.name)}<span class="bl-line">L${h.line}</span><span class="bl-snippet">${escapeHtml(h.snippet)}</span>`;
      li.onclick = () => openFile(l.file);
      backlinksBody.appendChild(li);
    }
  }
}

// ---- Wikilinks: render in editor + autocomplete + click ----------------
const wlPopover = document.getElementById('wl-popover');
const wlResults = document.getElementById('wl-results');
let wlActive = 0;
let wlMatches = [];
let wlAnchor = null; // { node, startOffset, endOffset, query }

const WL_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;

function decorateWikilinks() {
  if (!editorEl) return;
  // Walk text nodes, replacing [[...]] occurrences with anchor spans.
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.indexOf('[[') === -1) return NodeFilter.FILTER_REJECT;
      // Skip inside code blocks / pre / code / already-decorated
      let p = n.parentNode;
      while (p && p !== editorEl) {
        const tag = p.nodeName;
        if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('wikilink')) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue;
    WL_RE.lastIndex = 0;
    if (!WL_RE.test(text)) continue;
    WL_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = WL_RE.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const target = m[1].trim();
      const display = (m[2] || target).trim();
      const a = document.createElement('span');
      a.className = 'wikilink';
      a.dataset.target = target;
      a.textContent = display;
      a.title = `→ ${target}`;
      frag.appendChild(a);
      last = WL_RE.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// Click handler (delegated on editor)
if (editorEl) {
  editorEl.addEventListener('click', async (e) => {
    const wl = e.target.closest('.wikilink');
    if (!wl) return;
    e.preventDefault();
    e.stopPropagation();
    const target = wl.dataset.target;
    const resolved = await api.resolveWikilink(target);
    if (resolved) openFile(resolved);
    else wl.classList.add('broken');
  });
}

// Autocomplete on typing [[
function closeWlPopover() { wlPopover.classList.add('hidden'); wlMatches = []; wlAnchor = null; }
function getCaretContext() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) return null;
  const node = r.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  // Make sure caret is inside #editor
  let p = node.parentNode;
  let inEditor = false;
  while (p) { if (p === editorEl) { inEditor = true; break; } p = p.parentNode; }
  if (!inEditor) return null;
  const text = node.nodeValue || '';
  const before = text.slice(0, r.startOffset);
  // Look for [[ that hasn't been closed yet on this run
  const idx = before.lastIndexOf('[[');
  if (idx === -1) return null;
  const tail = before.slice(idx + 2);
  if (/[\]\n]/.test(tail)) return null;
  return { node, anchorStart: idx, query: tail, range: r };
}

async function maybeShowWlPopover() {
  const ctx = getCaretContext();
  if (!ctx) { closeWlPopover(); return; }
  const list = await api.listMdFiles();
  let matches;
  if (!ctx.query) {
    matches = list.slice(0, 8).map(f => ({ f, ranges: [], score: 0 }));
  } else {
    matches = [];
    for (const f of list) {
      const r = fuzzyMatch(f.rel, ctx.query);
      if (r) matches.push({ f, ranges: r.ranges, score: r.score });
    }
    matches.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, 8);
  }
  if (!matches.length) { closeWlPopover(); return; }
  wlMatches = matches;
  wlActive = 0;
  wlAnchor = ctx;
  wlResults.innerHTML = '';
  matches.forEach((m, i) => {
    const li = document.createElement('li');
    if (i === wlActive) li.classList.add('active');
    li.textContent = m.f.rel.replace(/\.(md|markdown)$/i, '');
    li.onclick = () => insertWlSelection(i);
    wlResults.appendChild(li);
  });
  // Position popover near caret
  const rect = ctx.range.getBoundingClientRect();
  wlPopover.style.left = `${Math.round(rect.left)}px`;
  wlPopover.style.top = `${Math.round(rect.bottom + 4)}px`;
  wlPopover.classList.remove('hidden');
}

function insertWlSelection(i) {
  if (!wlAnchor || !wlMatches[i]) return;
  const m = wlMatches[i];
  const name = m.f.name.replace(/\.(md|markdown)$/i, '');
  const node = wlAnchor.node;
  const text = node.nodeValue;
  // Replace from "[[" to caret with "[[Name]]"
  const sel = window.getSelection();
  const caret = sel.rangeCount ? sel.getRangeAt(0).startOffset : text.length;
  const before = text.slice(0, wlAnchor.anchorStart);
  const after = text.slice(caret);
  node.nodeValue = before + '[[' + name + ']]' + after;
  // Restore caret to end of inserted link
  const newPos = before.length + 2 + name.length + 2;
  const r = document.createRange();
  r.setStart(node, newPos);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  closeWlPopover();
  // Re-decorate to make the new wikilink clickable
  setTimeout(decorateWikilinks, 50);
}

if (editorEl) {
  editorEl.addEventListener('keyup', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
    maybeShowWlPopover();
  });
  editorEl.addEventListener('keydown', (e) => {
    if (wlPopover.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); wlActive = Math.min(wlActive + 1, wlMatches.length - 1); refreshWlActiveClass(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); wlActive = Math.max(wlActive - 1, 0); refreshWlActiveClass(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertWlSelection(wlActive); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWlPopover(); }
  });
}
function refreshWlActiveClass() {
  wlResults.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === wlActive));
  wlResults.querySelectorAll('li')[wlActive]?.scrollIntoView({ block: 'nearest' });
}
document.addEventListener('click', (e) => {
  if (!wlPopover.contains(e.target)) closeWlPopover();
});

// ---- Hook into openFile / markdownUpdated -------------------------------
// Patch openFile so outline + backlinks + wikilinks decorate after editor mounts.
const _origOpenFile = openFile;
openFile = async function patchedOpenFile(p) {
  await _origOpenFile(p);
  if (!FLAGS.editor) {
    outlineBody.innerHTML = '<li class="empty">[editor disabled]</li>';
    backlinksBody.innerHTML = '';
    backlinksCount.textContent = '';
    return;
  }
  try {
    const md = await api.readFile(p);
    renderOutline(md);
    refreshBacklinks(p);
    // Decorate wikilinks once Crepe has rendered
    setTimeout(decorateWikilinks, 100);
    setTimeout(decorateWikilinks, 400);
  } catch (err) {
    console.warn('wave1 hooks failed:', err);
  }
};

// Re-render outline on markdownUpdated (debounced)
if (typeof crepe !== 'undefined') { /* crepe is created per-file, can't hook here */ }
// Hook via interval — cheap enough for outline re-parse on dirty
let _lastOutlineMd = '';
setInterval(() => {
  if (!crepe) return;
  let md;
  try { md = crepe.getMarkdown(); } catch { return; }
  if (md && md !== _lastOutlineMd) {
    _lastOutlineMd = md;
    renderOutline(md);
    decorateWikilinks();
  }
}, 1500);

// ---- Wave 1.5: Comments rail --------------------------------------------
const LOCAL_AUTHOR = 'You (local)';
const commentsBody = document.getElementById('comments-body');
const commentsCount = document.getElementById('comments-count');
const commentsShowResolved = document.getElementById('comments-show-resolved');
let _lastCommentsDoc = null;
let _lastCommentsPath = null;

function fmtTimeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flattenComments(doc) {
  const all = doc?.comments || [];
  const byParent = new Map();
  for (const c of all) {
    const k = c.reply_to || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  const out = [];
  function walk(parent, depth) {
    const kids = byParent.get(parent) || [];
    for (const c of kids) {
      out.push({ ...c, _depth: depth });
      walk(c.id, depth + 1);
    }
  }
  walk('__root__', 0);
  return out;
}

function renderComments(doc, path) {
  _lastCommentsDoc = doc;
  _lastCommentsPath = path;
  if (!commentsBody) return; // rail not mounted yet
  const showResolved = commentsShowResolved?.checked;
  const all = flattenComments(doc);
  const visible = showResolved ? all : all.filter(c => !c.resolved);
  const open = all.filter(c => !c.resolved).length;
  if (commentsCount) commentsCount.textContent = all.length ? `${open}/${all.length}` : '';
  commentsBody.innerHTML = '';
  if (!path) { commentsBody.innerHTML = '<li class="empty">No file open</li>'; return; }
  if (!visible.length) {
    commentsBody.innerHTML = `<li class="empty">${all.length ? 'No open comments' : 'No comments yet'}</li>`;
    return;
  }
  for (const c of visible) {
    const li = document.createElement('li');
    li.className = 'comment-item' + (c.resolved ? ' resolved' : '');
    li.style.marginLeft = (c._depth * 12) + 'px';
    const sev = c.severity ? `<span class="comment-sev sev-${escHtml(c.severity)}">${escHtml(c.severity)}</span>` : '';
    const typ = c.type ? `<span class="comment-type">${escHtml(c.type)}</span>` : '';
    const line = c.line ? `<span class="comment-line">L${c.line}${c.end_line && c.end_line !== c.line ? `-${c.end_line}` : ''}</span>` : '';
    const author = escHtml(c.author || 'unknown');
    const when = fmtTimeAgo(c.created_at || c.updated_at);
    const text = escHtml(c.text || '');
    const sel = c.selected_text ? `<div class="comment-sel" title="anchored text">${escHtml(c.selected_text.slice(0, 120))}${c.selected_text.length > 120 ? '…' : ''}</div>` : '';
    const reactions = c.extensions?.x_reactions?.['+1'] || [];
    const myReaction = reactions.includes(LOCAL_AUTHOR);
    const plusOne = `<button class="reaction-btn${myReaction ? ' on' : ''}" data-act="plusone" data-id="${escHtml(c.id)}" title="${myReaction ? 'Remove +1' : '+1'} (${reactions.length ? reactions.join(', ') : 'no votes'})">👍 ${reactions.length || ''}</button>`;
    const actions = c.resolved
      ? `${plusOne}<button data-act="unresolve" data-id="${escHtml(c.id)}" title="Unresolve">↺</button>`
      : `${plusOne}<button data-act="resolve" data-id="${escHtml(c.id)}" title="Resolve">✓</button>
         <button data-act="reply" data-id="${escHtml(c.id)}" title="Reply">↪</button>`;
    li.innerHTML = `
      <div class="comment-head">
        <span class="comment-author">${author}</span>
        ${typ}${sev}${line}
        <span class="comment-when">${when}</span>
      </div>
      ${sel}
      <div class="comment-text">${text.replace(/\n/g, '<br>')}</div>
      <div class="comment-actions">${actions}</div>
    `;
    li.querySelector('.comment-head').addEventListener('click', () => {
      if (c.line) scrollEditorToLine(c.line);
      openCommentModal(c.id);
    });
    // Click on body text / anchor also opens the modal
    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;          // let action buttons handle their clicks
      if (e.target.closest('.comment-head')) return;   // already handled above
      if (c.line) scrollEditorToLine(c.line);
      openCommentModal(c.id);
    });
    li.style.cursor = 'pointer';
    commentsBody.appendChild(li);
  }
}

function scrollEditorToLine(line) {
  // Best-effort: scroll the editor host by approx line. Crepe doesn't expose
  // a line→DOM mapping, so we estimate via paragraph index from current md.
  if (!crepe) return;
  let md;
  try { md = crepe.getMarkdown(); } catch { return; }
  const lines = md.split('\n');
  const target = Math.max(0, Math.min(line - 1, lines.length - 1));
  const editorEl = document.querySelector('#editor .ProseMirror') || document.getElementById('editor');
  if (!editorEl) return;
  const ratio = target / Math.max(1, lines.length);
  const host = document.getElementById('editor-host');
  host.scrollTop = host.scrollHeight * ratio;
}

async function refreshComments(path) {
  if (!FLAGS.comments) {
    commentsBody.innerHTML = '<li class="empty">[comments disabled]</li>';
    commentsCount.textContent = '';
    return;
  }
  if (!path) { renderComments(null, null); return; }
  try {
    const sc = await api.readSidecar(path);
    renderComments(sc?.doc || null, path);
  } catch (err) {
    console.warn('refreshComments failed', err);
    commentsBody.innerHTML = '<li class="empty">Error loading sidecar</li>';
  }
}

commentsShowResolved?.addEventListener('change', () => {
  if (_lastCommentsDoc) renderComments(_lastCommentsDoc, _lastCommentsPath);
});

commentsBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  if (!_lastCommentsPath || !_lastCommentsDoc) return;
  try {
    const doc = JSON.parse(JSON.stringify(_lastCommentsDoc));
    const c = (doc.comments || []).find(x => x.id === id);
    if (!c) return;
    if (act === 'resolve') c.resolved = true;
    else if (act === 'unresolve') c.resolved = false;
    else if (act === 'plusone') {
      c.extensions = c.extensions || {};
      c.extensions.x_reactions = c.extensions.x_reactions || {};
      const list = c.extensions.x_reactions['+1'] = c.extensions.x_reactions['+1'] || [];
      const idx = list.indexOf(LOCAL_AUTHOR);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(LOCAL_AUTHOR);
      if (!list.length) delete c.extensions.x_reactions['+1'];
      if (!Object.keys(c.extensions.x_reactions).length) delete c.extensions.x_reactions;
      if (!Object.keys(c.extensions).length) delete c.extensions;
    }
    else if (act === 'reply') {
      openCommentModal(id);
      return;
    }
    await api.writeSidecar(_lastCommentsPath, doc);
    renderComments(doc, _lastCommentsPath);
    // If modal is open on this thread, refresh it
    if (_modalOpenRootId) renderCommentModal(_modalOpenRootId);
  } catch (err) {
    console.warn('comment action failed', err);
  }
});

// ---- Comment thread modal ----------------------------------------------
const cmtModal = document.getElementById('cmt-modal');
const cmtModalBackdrop = cmtModal?.querySelector('.cmt-modal-backdrop');
const cmtModalClose = cmtModal?.querySelector('.cmt-modal-close');
const cmtModalThread = cmtModal?.querySelector('.cmt-modal-thread');
const cmtModalLine = cmtModal?.querySelector('.cmt-modal-line');
const cmtModalAnchor = cmtModal?.querySelector('.cmt-modal-anchor');
const cmtModalTextarea = cmtModal?.querySelector('.cmt-modal-reply textarea');
const cmtModalPost = cmtModal?.querySelector('.cmt-modal-post');
const cmtModalResolve = cmtModal?.querySelector('.cmt-modal-resolve');

let _modalOpenRootId = null;

function findRootId(commentId, comments) {
  let cur = (comments || []).find(x => x.id === commentId);
  if (!cur) return commentId;
  const byId = new Map(comments.map(c => [c.id, c]));
  while (cur && cur.reply_to && byId.has(cur.reply_to)) cur = byId.get(cur.reply_to);
  return cur?.id || commentId;
}

function getThread(rootId, comments) {
  const all = comments || [];
  const root = all.find(c => c.id === rootId);
  if (!root) return [];
  const byParent = new Map();
  for (const c of all) {
    const k = c.reply_to || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  const out = [{ ...root, _depth: 0 }];
  function walk(parent, depth) {
    const kids = byParent.get(parent) || [];
    kids.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    for (const c of kids) { out.push({ ...c, _depth: depth }); walk(c.id, depth + 1); }
  }
  walk(rootId, 1);
  return out;
}

function openCommentModal(commentId) {
  if (!cmtModal || !_lastCommentsDoc) return;
  const rootId = findRootId(commentId, _lastCommentsDoc.comments || []);
  _modalOpenRootId = rootId;
  renderCommentModal(rootId);
  cmtModal.classList.remove('hidden');
  setTimeout(() => cmtModalTextarea?.focus(), 30);
}

function closeCommentModal() {
  if (!cmtModal) return;
  cmtModal.classList.add('hidden');
  _modalOpenRootId = null;
  if (cmtModalTextarea) cmtModalTextarea.value = '';
}

function renderCommentModal(rootId) {
  if (!cmtModal || !_lastCommentsDoc) return;
  const thread = getThread(rootId, _lastCommentsDoc.comments || []);
  const root = thread[0];
  if (!root) { closeCommentModal(); return; }
  cmtModalLine.textContent = root.line ? `L${root.line}${root.end_line && root.end_line !== root.line ? `-${root.end_line}` : ''}` : '';
  cmtModalAnchor.textContent = root.selected_text ? `“${root.selected_text.slice(0, 140)}${root.selected_text.length > 140 ? '…' : ''}”` : '';
  cmtModalThread.innerHTML = '';
  for (const c of thread) {
    const div = document.createElement('div');
    div.className = 'cmt-msg' + (c._depth > 0 ? ' reply' : '') + (c.resolved ? ' resolved' : '');
    const reactions = c.extensions?.x_reactions?.['+1'] || [];
    const myReact = reactions.includes(LOCAL_AUTHOR);
    div.innerHTML = `
      <div class="cmt-msg-head">
        <span class="cmt-msg-author">${escHtml(c.author || 'unknown')}</span>
        <span class="cmt-msg-when">${fmtTimeAgo(c.created_at || c.updated_at)}</span>
        <span class="cmt-msg-spacer"></span>
      </div>
      <div class="cmt-msg-body">${mdToHtml(c.text || '')}</div>
      <div class="cmt-msg-foot">
        <button data-modal-act="plusone" data-id="${escHtml(c.id)}" class="${myReact ? 'on' : ''}">👍 ${reactions.length || ''}</button>
      </div>`;
    cmtModalThread.appendChild(div);
  }
  // Update resolve button label based on root
  if (cmtModalResolve) {
    cmtModalResolve.textContent = root.resolved ? '↺ Unresolve' : '✓ Resolve';
    cmtModalResolve.dataset.act = root.resolved ? 'unresolve' : 'resolve';
  }
  cmtModalThread.scrollTop = cmtModalThread.scrollHeight;
}

async function postReply() {
  const text = (cmtModalTextarea?.value || '').trim();
  if (!text || !_modalOpenRootId || !_lastCommentsPath || !_lastCommentsDoc) return;
  try {
    const doc = JSON.parse(JSON.stringify(_lastCommentsDoc));
    doc.comments = doc.comments || [];
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    doc.comments.push({
      id: newId,
      reply_to: _modalOpenRootId,
      author: LOCAL_AUTHOR || 'You (local)',
      text,
      created_at: new Date().toISOString(),
    });
    await api.writeSidecar(_lastCommentsPath, doc);
    cmtModalTextarea.value = '';
    renderComments(doc, _lastCommentsPath);
    renderCommentModal(_modalOpenRootId);
  } catch (err) {
    console.warn('postReply failed', err);
  }
}

async function modalToggleResolve() {
  if (!_modalOpenRootId || !_lastCommentsPath || !_lastCommentsDoc) return;
  try {
    const doc = JSON.parse(JSON.stringify(_lastCommentsDoc));
    const root = (doc.comments || []).find(x => x.id === _modalOpenRootId);
    if (!root) return;
    root.resolved = !root.resolved;
    await api.writeSidecar(_lastCommentsPath, doc);
    renderComments(doc, _lastCommentsPath);
    renderCommentModal(_modalOpenRootId);
  } catch (err) { console.warn('toggle resolve failed', err); }
}

cmtModalClose?.addEventListener('click', closeCommentModal);
cmtModalBackdrop?.addEventListener('click', closeCommentModal);
cmtModalPost?.addEventListener('click', postReply);
cmtModalResolve?.addEventListener('click', modalToggleResolve);
cmtModalTextarea?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeCommentModal(); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postReply(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cmtModal && !cmtModal.classList.contains('hidden')) {
    closeCommentModal();
  }
});

// In-modal reaction buttons
cmtModalThread?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-modal-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-modal-act');
  if (!_lastCommentsPath || !_lastCommentsDoc) return;
  try {
    const doc = JSON.parse(JSON.stringify(_lastCommentsDoc));
    const c = (doc.comments || []).find(x => x.id === id);
    if (!c) return;
    if (act === 'plusone') {
      c.extensions = c.extensions || {};
      c.extensions.x_reactions = c.extensions.x_reactions || {};
      const list = c.extensions.x_reactions['+1'] = c.extensions.x_reactions['+1'] || [];
      const idx = list.indexOf(LOCAL_AUTHOR);
      if (idx >= 0) list.splice(idx, 1); else list.push(LOCAL_AUTHOR);
      if (!list.length) delete c.extensions.x_reactions['+1'];
      if (!Object.keys(c.extensions.x_reactions).length) delete c.extensions.x_reactions;
      if (!Object.keys(c.extensions).length) delete c.extensions;
    }
    await api.writeSidecar(_lastCommentsPath, doc);
    renderComments(doc, _lastCommentsPath);
    renderCommentModal(_modalOpenRootId);
  } catch (err) { console.warn('modal reaction failed', err); }
});

// Hook openFile to also refresh comments
const _origOpenForComments = openFile;
openFile = async function openFileWithComments(p) {
  await _origOpenForComments(p);
  refreshComments(p);
  // Hide gallery panel when a file is opened
  if (typeof closeGallery === 'function') closeGallery();
  // Scroll editor + host to top
  const eh = document.getElementById('editor-host');
  if (eh) eh.scrollTop = 0;
  const ed = document.getElementById('editor');
  if (ed) {
    ed.scrollTop = 0;
    const scroller = ed.querySelector('.milkdown, .ProseMirror, [class*="scroll"]');
    if (scroller) scroller.scrollTop = 0;
  }
};

// Watch for sidecar changes from other agents → re-render
if (api.onFsEvent) {
  api.onFsEvent((ev) => {
    if (!_lastCommentsPath) return;
    if (!ev || !ev.path) return;
    const sc = _lastCommentsPath.replace(/\.md$/i, '.review.yaml');
    if (ev.path === sc || ev.path.endsWith('.review.yaml')) {
      refreshComments(_lastCommentsPath);
    }
  });
}
