// src/chorus.js — V1.5 LLM collaboration client (Symbiont Chorus)
//
// Talks to symbiont-chorus (loopback HTTP + MCP server registered in
// Clawpilot) via main-process IPC. Manages connection status, queues
// /ask requests, and notifies Chorus when the user replies in a thread.
//
// V1 is "inverted MCP": this module never receives an LLM answer
// directly. Chorus writes the question into the doc's MRSF sidecar as a
// pending comment; Clawpilot picks it up via Chorus's MCP tools and
// writes the answer back as an agent reply, which the existing sidecar
// watcher renders in the gutter.
//
// Design doc: product-design/md-viewer/llm-collaboration.md

const HEALTH_INTERVAL_MS = 5000;

const state = {
  connected: false,
  port: null,
  mode: null,
  pending: null,
  lastError: null,
};

const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try { fn({ ...state }); } catch (err) { console.warn('chorus listener', err); }
  }
}
export function onChorusStatus(fn) {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}
export const onBridgeStatus = onChorusStatus;

async function pollHealth() {
  try {
    const res = await window.api.bridgeHealth();
    if (res.ok) {
      state.connected = true;
      state.port = res.port;
      state.mode = res.mode;
      state.pending = typeof res.pending === 'number' ? res.pending : null;
      state.lastError = null;
    } else {
      state.connected = false;
      state.lastError = res.error || res.code || 'unknown';
    }
  } catch (err) {
    state.connected = false;
    state.lastError = err?.message || String(err);
  }
  emit();
}

let _timer = null;
export function startChorusStatusPolling() {
  if (_timer) return;
  pollHealth();
  _timer = setInterval(pollHealth, HEALTH_INTERVAL_MS);
}
export const startBridgeStatusPolling = startChorusStatusPolling;
export function refreshChorusStatus() { return pollHealth(); }
export const refreshBridgeStatus = refreshChorusStatus;

// --- Selection capture --------------------------------------------------

function findLineRange(sourceMd, selectedText) {
  if (!sourceMd || !selectedText) return null;
  const idx = sourceMd.indexOf(selectedText);
  if (idx === -1) return null;
  const before = sourceMd.slice(0, idx);
  const startLine = before.split('\n').length;
  const endLine = startLine + selectedText.split('\n').length - 1;
  return { startLine, endLine };
}

function readEditorSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return '';
  return (sel.toString() || '').trim();
}

// --- Public API ---------------------------------------------------------

export async function ask({ docPath, sourceMd, intent = 'ask', question }) {
  if (!docPath) return { ok: false, error: 'no document open' };
  if (!state.connected) {
    return { ok: false, error: 'Chorus not running. Start Clawpilot to enable AI replies.' };
  }
  const selectedText = readEditorSelection();
  if (!selectedText && !question) {
    return { ok: false, error: 'Select some text or provide a question first.' };
  }
  const range = selectedText ? findLineRange(sourceMd, selectedText) : null;
  const payload = {
    docPath,
    intent,
    question: question || null,
    selection: selectedText
      ? {
          text: selectedText,
          startLine: range?.startLine,
          endLine: range?.endLine,
        }
      : {},
  };
  const res = await window.api.bridgeAsk(payload);
  return res;
}

export async function notifyReply({ docPath, threadId, replyText }) {
  if (!docPath || !threadId) return { ok: false, error: 'docPath + threadId required' };
  return window.api.bridgeReply({ docPath, threadId, question: replyText || '' });
}

export const _internal = { findLineRange };
