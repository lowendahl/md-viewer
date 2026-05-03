// renderer.js — ES module, runs in Electron renderer
import { Marked } from './node_modules/marked/lib/marked.esm.js';
import { markedMrsf } from './node_modules/@mrsf/marked-mrsf/dist/browser.js';
import { MrsfController } from './node_modules/@mrsf/marked-mrsf/dist/controller.js';
import DOMPurify from './node_modules/dompurify/dist/purify.es.mjs';

const tree = document.getElementById('tree');
const logEl = document.getElementById('log');
const pickBtn = document.getElementById('pick-folder');
const rootPathEl = document.getElementById('root-path');
const editor = document.getElementById('editor');
const currentFileEl = document.getElementById('current-file');
const dirtyDot = document.getElementById('dirty-dot');
const saveStateEl = document.getElementById('save-state');
const saveBtn = document.getElementById('save-btn');
const clearLogBtn = document.getElementById('clear-log');
const commentCountEl = document.getElementById('comment-count');
const commentsToggle = document.getElementById('comments-toggle');

let currentFile = null;
let currentSidecar = null;   // MrsfDocument or null
let currentMd = '';
let dirty = false;
let saveTimer = null;
let mrsfController = null;
let commentsVisible = true;

// ---- Markdown <-> HTML ----
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.addRule('strikethrough', { filter: ['del', 's', 'strike'], replacement: c => `~~${c}~~` });
// Drop sidemark badges, gutter, mark wrappers — they are decoration, not content
td.addRule('mrsf-strip', {
  filter: (node) => node.nodeType === 1 && (
    /^mrsf-/.test(node.className || '') ||
    node.hasAttribute?.('data-mrsf') ||
    node.tagName === 'SCRIPT' && node.getAttribute('type') === 'application/mrsf+json'
  ),
  replacement: () => '',
});
// <mark> wrappers: keep inner text only
td.addRule('mrsf-mark', {
  filter: (node) => node.tagName === 'MARK' && /mrsf-/.test(node.className || ''),
  replacement: (content) => content,
});

function renderMarkdown(md, sidecarDoc) {
  const m = new Marked();
  if (commentsVisible && sidecarDoc) {
    m.use(markedMrsf({
      comments: sidecarDoc,
      interactive: true,
      gutterPosition: 'right',
      inlineHighlights: true,
      lineHighlight: true,
      theme: 'dark',
    }));
  }
  const html = m.parse(md);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-mrsf', 'data-mrsf-action', 'data-mrsf-comment-id', 'data-mrsf-line', 'data-line', 'data-mrsf-thread'],
    ADD_TAGS: ['mark'],
  });
}

// ---- Tree ----
function renderTree(node, container, depth = 0) {
  if (node.type === 'dir') {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'node dir open';
    head.innerHTML = `<span class="caret">▶</span> 📂 ${escapeHtml(node.name)}`;
    const childWrap = document.createElement('div');
    childWrap.className = 'children';
    head.onclick = () => {
      head.classList.toggle('open');
      childWrap.classList.toggle('collapsed', !head.classList.contains('open'));
    };
    wrap.appendChild(head);
    wrap.appendChild(childWrap);
    container.appendChild(wrap);
    for (const c of node.children) renderTree(c, childWrap, depth + 1);
  } else {
    const item = document.createElement('div');
    item.className = 'node file';
    item.dataset.path = node.path;
    const badge = node.hasComments ? ' <span class="cbadge" title="Has Sidemark comments">💬</span>' : '';
    item.innerHTML = `📄 ${escapeHtml(node.name)}${badge}`;
    item.onclick = () => openFile(node.path);
    container.appendChild(item);
  }
}

function setActive(path) {
  document.querySelectorAll('.node.file').forEach(n => {
    n.classList.toggle('active', n.dataset.path === path);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Editor ----
async function openFile(p) {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentFile = p;
  const md = await window.api.readFile(p);
  const sc = await window.api.readSidecar(p);
  currentMd = md;
  currentSidecar = sc.doc || null;
  renderEditor();
  dirty = false;
  updateStatus();
  currentFileEl.textContent = p;
  currentFileEl.title = p;
  setActive(p);
  editor.focus();
}

function renderEditor() {
  destroyController();
  editor.innerHTML = renderMarkdown(currentMd, currentSidecar);
  attachController();
  updateCommentCount();
}

function destroyController() {
  if (mrsfController) {
    try { mrsfController.destroy(); } catch {}
    mrsfController = null;
  }
}

function attachController() {
  if (!commentsVisible || !currentSidecar) return;
  try {
    mrsfController = new MrsfController(editor, {
      interactive: true,
      gutterPosition: 'right',
      inlineHighlights: true,
    });
  } catch (err) {
    console.warn('Sidemark controller failed:', err);
  }
}

function updateCommentCount() {
  const n = currentSidecar?.comments?.length ?? 0;
  if (n) {
    const open = currentSidecar.comments.filter(c => !c.resolved).length;
    commentCountEl.textContent = `💬 ${open}/${n}`;
    commentCountEl.style.display = '';
  } else {
    commentCountEl.textContent = '';
    commentCountEl.style.display = 'none';
  }
}

function updateStatus() {
  dirtyDot.classList.toggle('hidden', !dirty);
  saveStateEl.textContent = dirty ? 'unsaved' : 'saved';
  saveBtn.disabled = !dirty;
}

async function saveFile() {
  if (!currentFile || !dirty) return;
  // Clone editor and strip sidemark decoration before turndown
  const clone = editor.cloneNode(true);
  clone.querySelectorAll('.mrsf-gutter, .mrsf-overlay, [data-mrsf-action], script[type="application/mrsf+json"]').forEach(n => n.remove());
  const md = td.turndown(clone.innerHTML);
  await window.api.writeFile(currentFile, md);
  currentMd = md;
  dirty = false;
  updateStatus();
}

editor.addEventListener('input', (e) => {
  if (!currentFile) return;
  // Ignore mutations from the controller's overlay UI
  if (e.target?.closest?.('.mrsf-gutter, .mrsf-overlay, [data-mrsf-action]')) return;
  dirty = true;
  updateStatus();
  applyInlineMarkdown();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFile, 1500);
});

document.execCommand('defaultParagraphSeparator', false, 'p');

function applyInlineMarkdown() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  let block = range.startContainer;
  while (block && block.parentNode !== editor) {
    block = block.parentNode;
    if (!block) return;
  }
  if (!block || block === editor) return;

  const text = block.textContent;
  const headingMatch = text.match(/^(#{1,6}) (.*)$/);
  if (headingMatch && !/^H[1-6]$/.test(block.tagName)) {
    transformBlock(block, 'H' + headingMatch[1].length, headingMatch[2]);
    return;
  }
  let m = text.match(/^[-*+] (.*)$/);
  if (m && block.tagName !== 'LI') { transformToList(block, 'UL', m[1]); return; }
  m = text.match(/^\d+\. (.*)$/);
  if (m && block.tagName !== 'LI') { transformToList(block, 'OL', m[1]); return; }
  m = text.match(/^> (.*)$/);
  if (m && block.tagName !== 'BLOCKQUOTE') { transformBlock(block, 'BLOCKQUOTE', m[1]); return; }
  if (/^---$/.test(text) || /^\*\*\*$/.test(text)) {
    const hr = document.createElement('hr');
    const p = document.createElement('p'); p.innerHTML = '<br>';
    block.replaceWith(hr); hr.after(p); placeCaretAtStart(p); return;
  }
  m = text.match(/^```(\w*)$/);
  if (m) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (m[1]) code.className = 'language-' + m[1];
    code.textContent = '\n';
    pre.appendChild(code);
    block.replaceWith(pre); placeCaretAtStart(code);
    return;
  }
}

function transformBlock(oldBlock, tagName, innerText) {
  const el = document.createElement(tagName);
  el.textContent = innerText;
  oldBlock.replaceWith(el);
  placeCaretAtEnd(el);
}
function transformToList(oldBlock, listTag, innerText) {
  const list = document.createElement(listTag);
  const li = document.createElement('li');
  li.textContent = innerText;
  list.appendChild(li);
  oldBlock.replaceWith(list);
  placeCaretAtEnd(li);
}
function placeCaretAtEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function placeCaretAtStart(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    let block = sel.anchorNode;
    while (block && block.parentNode !== editor) block = block.parentNode;
    if (block && /^H[1-6]$|^BLOCKQUOTE$/.test(block.tagName)) {
      e.preventDefault();
      const p = document.createElement('p'); p.innerHTML = '<br>';
      block.after(p); placeCaretAtStart(p);
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); saveFile();
  }
});

// ---- Sidemark events ----
function uuid() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function ensureSidecarDoc() {
  if (!currentSidecar) {
    const docPath = currentFile ? currentFile.split(/[\\\/]/).pop() : '';
    currentSidecar = { mrsf_version: '1.0', document: docPath, comments: [] };
  }
  return currentSidecar;
}

async function persistSidecar() {
  if (!currentFile) return;
  if (!currentSidecar || !currentSidecar.comments.length) {
    await window.api.deleteSidecar(currentFile);
  } else {
    await window.api.writeSidecar(currentFile, currentSidecar);
  }
  updateCommentCount();
}

async function rerenderAfterCommentChange() {
  // Re-render editor without losing user focus too jarringly
  const md = await window.api.readFile(currentFile);
  currentMd = md;
  // Re-load sidecar from disk to capture any external changes
  const sc = await window.api.readSidecar(currentFile);
  currentSidecar = sc.doc || currentSidecar;
  renderEditor();
}

document.addEventListener('mrsf:submit', async (e) => {
  const d = e.detail;
  const doc = ensureSidecarDoc();
  const now = new Date().toISOString();
  if (d.action === 'add') {
    doc.comments.push({
      id: uuid(),
      author: 'You (local)',
      timestamp: now,
      text: d.text,
      resolved: false,
      line: d.line ?? null,
      end_line: d.end_line ?? d.line ?? null,
      start_column: d.start_column ?? null,
      end_column: d.end_column ?? null,
      selected_text: d.selection_text ?? null,
      type: d.type ?? null,
      severity: d.severity ?? null,
    });
  } else if (d.action === 'edit') {
    const c = doc.comments.find(x => x.id === d.commentId);
    if (c) { c.text = d.text; c.timestamp = now; }
  } else if (d.action === 'reply') {
    doc.comments.push({
      id: uuid(),
      author: 'You (local)',
      timestamp: now,
      text: d.text,
      resolved: false,
      reply_to: d.commentId,
    });
  } else if (d.action === 'resolve' || d.action === 'unresolve') {
    const c = doc.comments.find(x => x.id === d.commentId);
    if (c) c.resolved = d.action === 'resolve';
  } else if (d.action === 'delete') {
    doc.comments = doc.comments.filter(x => x.id !== d.commentId && x.reply_to !== d.commentId);
  }
  await persistSidecar();
  await rerenderAfterCommentChange();
});

document.addEventListener('mrsf:resolve', () => {});
document.addEventListener('mrsf:unresolve', () => {});

// Toggle comments visibility
commentsToggle.addEventListener('change', () => {
  commentsVisible = commentsToggle.checked;
  if (currentFile) renderEditor();
});

// ---- Folder + file watcher ----
pickBtn.onclick = async () => {
  const folder = await window.api.pickFolder();
  if (folder) loadRoot(folder);
};

async function loadRoot(folder) {
  rootPathEl.textContent = folder;
  rootPathEl.title = folder;
  const data = await window.api.loadTree(folder);
  tree.innerHTML = '';
  renderTree(data, tree);
  localStorage.setItem('lastFolder', folder);
}

window.api.onFsEvent(async ({ event, path: p, isSidecar, time }) => {
  addLog(event, p, isSidecar, time);
  if (isSidecar) {
    // If sidecar of currently open file changed, reload it
    if (currentFile && p.startsWith(currentFile.replace(/\.(md|markdown)$/i, ''))) {
      const sc = await window.api.readSidecar(currentFile);
      currentSidecar = sc.doc || null;
      renderEditor();
    }
    return;
  }
  if (event === 'changed' && p === currentFile && !dirty) {
    const md = await window.api.readFile(p);
    currentMd = md;
    renderEditor();
  }
});

window.api.onTreeDirty(() => {
  clearTimeout(window._treeRefresh);
  window._treeRefresh = setTimeout(async () => {
    const folder = localStorage.getItem('lastFolder');
    if (folder) {
      const data = await window.api.loadTree(folder);
      tree.innerHTML = '';
      renderTree(data, tree);
      setActive(currentFile);
    }
  }, 400);
});

function addLog(event, p, isSidecar, time) {
  const li = document.createElement('li');
  const t = new Date(time);
  const tag = isSidecar ? `<span class="kind sidecar">sidecar</span>` : '';
  li.innerHTML = `<span class="ev ${event}">${event}</span>${tag}<span class="fname"></span><span class="ts">${t.toLocaleTimeString()}</span>`;
  li.querySelector('.fname').textContent = p.split(/[\\\/]/).pop();
  li.title = p;
  li.onclick = () => {
    if (event === 'removed') return;
    if (isSidecar) {
      // Open the related .md file
      const md = p.replace(/\.review\.(ya?ml|json)$/i, '.md');
      openFile(md);
    } else {
      openFile(p);
    }
  };
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.removeChild(logEl.lastChild);
}

clearLogBtn.onclick = () => { logEl.innerHTML = ''; };
saveBtn.onclick = saveFile;

// Restore last folder
const last = localStorage.getItem('lastFolder');
if (last) loadRoot(last);
