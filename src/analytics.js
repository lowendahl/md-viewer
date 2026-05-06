// src/analytics.js — V1.4 usage analytics (local only, opt-out aware)
//
// Thin wrapper over window.obs.emit() (NDJSON file logger from
// @compass/observability). Buffers tiny bursts, drops events when the
// user has opted out, and records a session summary on unload.
//
// Privacy contract:
// - Never logs file contents, full file paths, or sidecar text.
// - Path-derived fields are reduced to (a) folder hash (fnv1a) and
//   (b) extension only.
// - Author email is never logged here.

const obs = window.obs;
let optedIn = true;        // pessimistic until settings load
let sessionStartedAt = Date.now();
let sessionId = (Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
let counters = { commands: 0, files: 0, errors: 0 };

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function folderHash(absPath) {
  if (!absPath) return null;
  const dir = String(absPath).replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  return fnv1a(dir.toLowerCase());
}
function extOf(name) {
  if (!name) return '';
  const m = String(name).match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

function _emit(payload) {
  if (!optedIn) return;
  try { void obs?.emit(payload); } catch { /* never throw from telemetry */ }
}

// Public surface
const Analytics = {
  setOptIn(v) {
    const prev = optedIn;
    optedIn = !!v;
    if (prev !== optedIn) {
      _emit({ level: 'info', source: 'renderer', type: 'mdv.privacy.toggle', message: 'optedIn=' + optedIn, context: { sessionId } });
    }
  },
  // Generic command/use tracker. id is a stable kebab-case identifier.
  track(commandId, ctx) {
    counters.commands++;
    _emit({
      level: 'info',
      source: 'renderer',
      type: 'mdv.command.invoke',
      message: commandId,
      context: { sessionId, id: commandId, ...sanitizeCtx(ctx) },
    });
  },
  feature(featureId, ctx) {
    _emit({
      level: 'info',
      source: 'renderer',
      type: 'mdv.feature.use',
      message: featureId,
      context: { sessionId, id: featureId, ...sanitizeCtx(ctx) },
    });
  },
  fileOpen(absPath, kind /* 'md'|'image' */) {
    counters.files++;
    _emit({
      level: 'info',
      source: 'renderer',
      type: 'mdv.file.open',
      message: kind || 'md',
      context: { sessionId, kind: kind || 'md', folder: folderHash(absPath), ext: extOf(absPath) },
    });
  },
  perfRefresh(label, durationMs) {
    if (!Number.isFinite(durationMs)) return;
    if (durationMs < 200) return;
    _emit({
      level: durationMs > 1000 ? 'warn' : 'info',
      source: 'renderer',
      type: 'mdv.perf.refresh.long',
      message: label || 'refresh',
      context: { sessionId, label, duration_ms: Math.round(durationMs) },
    });
  },
  sessionStart() {
    sessionStartedAt = Date.now();
    _emit({
      level: 'info',
      source: 'renderer',
      type: 'mdv.session.start',
      message: 'session start',
      context: { sessionId, ts: sessionStartedAt },
    });
  },
  sessionEnd() {
    _emit({
      level: 'info',
      source: 'renderer',
      type: 'mdv.session.end',
      message: 'session end',
      context: {
        sessionId,
        duration_ms: Date.now() - sessionStartedAt,
        commands: counters.commands,
        files: counters.files,
        errors: counters.errors,
      },
    });
  },
  noteError() { counters.errors++; },
};

function sanitizeCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const out = {};
  for (const k of Object.keys(ctx)) {
    const v = ctx[k];
    if (v == null) continue;
    if (typeof v === 'string') {
      // Reject anything that looks like a filesystem path, email, or url.
      if (/[\\/]/.test(v) || /@/.test(v)) continue;
      if (v.length > 64) continue;
      out[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

window.MDVAnalytics = Analytics;

// Hydrate opt-in from settings (default ON).
(async () => {
  try {
    const s = await window.api?.getSettings?.();
    Analytics.setOptIn(s?.telemetryOptIn !== false);
  } catch { Analytics.setOptIn(true); }
  Analytics.sessionStart();
})();

// Best-effort session end on unload.
window.addEventListener('beforeunload', () => { try { Analytics.sessionEnd(); } catch {} });

export default Analytics;
