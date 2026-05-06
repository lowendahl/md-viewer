// src/insights.js — V1.4 Insights panel (📊 in topbar)
//
// Pulls aggregated usage stats from the main process via
// window.api.analyticsSnapshot() and renders four cards:
//   1. Top commands (last 30 days)
//   2. Unused features (zero invokes in last 30 days)
//   3. Sessions per day sparkline
//   4. Slow refresh hotspots (count + p95)

const api = window.api;

// Catalogue of features Insights knows to look for. Populated at build
// time so "Unused features" can show what the user has NOT used.
// Keep these in sync with Analytics.track() / feature() call sites.
const FEATURE_CATALOGUE = [
  // Commands
  'find.open', 'find.next', 'find.close',
  'tree.filter', 'tree.delete', 'tree.rename', 'tree.new-file', 'tree.new-folder',
  'tree.open-location', 'tree.drag-out',
  'file.save', 'file.print-pdf',
  'comments.toggle', 'comments.reanchor', 'comments.add', 'comments.reply', 'comments.resolve',
  'lightbox.open',
  'theme.set',
  'gallery.open', 'gallery.sort-changed', 'gallery.sort-name', 'gallery.sort-opened',
  'quickswitch.open', 'fulltext.open',
  'undo', 'redo',
  'settings.open', 'about.open', 'manual.open', 'changelog.open',
  'updates.check',
  'insights.open',
];

function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    if (k === 'class') e.className = props[k];
    else if (k === 'html') e.innerHTML = props[k];
    else if (k.startsWith('on') && typeof props[k] === 'function') e.addEventListener(k.slice(2), props[k]);
    else e.setAttribute(k, props[k]);
  }
  if (children) for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTopCommands(container, snap) {
  const list = (snap.topCommands || []).slice(0, 10);
  if (!list.length) { container.innerHTML = '<div class="ins-empty">No usage recorded yet.</div>'; return; }
  const max = list[0].count || 1;
  const html = list.map(c => `
    <div class="ins-row">
      <div class="ins-bar-label">${escapeHtml(c.id)}</div>
      <div class="ins-bar-track"><div class="ins-bar" style="width:${Math.round(c.count * 100 / max)}%"></div></div>
      <div class="ins-bar-num">${c.count}</div>
    </div>
  `).join('');
  container.innerHTML = html;
}

function renderUnused(container, snap) {
  const used = new Set((snap.allCommands || []).map(c => c.id));
  const unused = FEATURE_CATALOGUE.filter(f => !used.has(f));
  if (!unused.length) {
    container.innerHTML = '<div class="ins-empty">All catalogued features have been used in this window. 🎉</div>';
    return;
  }
  container.innerHTML = `
    <div class="ins-help">Catalogued features with zero recorded use. Candidates to remove, demote, or surface better.</div>
    <ul class="ins-unused">${unused.map(f => '<li>' + escapeHtml(f) + '</li>').join('')}</ul>
  `;
}

function renderSparkline(container, snap) {
  const days = snap.sessionsPerDay || [];
  if (!days.length) { container.innerHTML = '<div class="ins-empty">No sessions recorded yet.</div>'; return; }
  const max = Math.max(1, ...days.map(d => d.count));
  const w = 280, h = 64, pad = 6;
  const stepX = (w - pad * 2) / Math.max(1, days.length - 1);
  const pts = days.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((d.count / max) * (h - pad * 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const total = days.reduce((s, d) => s + d.count, 0);
  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" class="ins-spark">
      <polyline fill="none" stroke="currentColor" stroke-width="2" points="${pts.join(' ')}" />
    </svg>
    <div class="ins-spark-foot">
      <span><b>${total}</b> sessions / ${days.length} days</span>
      <span>peak: <b>${max}</b>/day</span>
    </div>
  `;
}

function renderPerf(container, snap) {
  const buckets = snap.perfHotspots || [];
  if (!buckets.length) { container.innerHTML = '<div class="ins-empty">No slow refreshes recorded. 🚀</div>'; return; }
  container.innerHTML = `
    <table class="ins-perf">
      <thead><tr><th>Label</th><th>Count</th><th>Median (ms)</th><th>p95 (ms)</th></tr></thead>
      <tbody>${buckets.map(b => `
        <tr>
          <td>${escapeHtml(b.label)}</td>
          <td>${b.count}</td>
          <td>${b.median}</td>
          <td>${b.p95}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

export async function openInsights() {
  try { window.MDVAnalytics?.track('insights.open'); } catch {}
  // Build modal
  const overlay = el('div', { class: 'mdv-modal-overlay ins-overlay' });
  overlay.innerHTML = `
    <div class="mdv-modal-card mdv-modal-wide">
      <div class="mdv-modal-head">
        <span class="mdv-modal-title">📊 Insights — last 30 days</span>
        <span class="mdv-modal-sub" id="ins-meta"></span>
        <button class="mdv-modal-close" title="Close">×</button>
      </div>
      <div class="mdv-modal-body">
        <div class="ins-grid">
          <section class="ins-card">
            <h3>Top commands</h3>
            <div id="ins-top">Loading…</div>
          </section>
          <section class="ins-card">
            <h3>Sessions / day</h3>
            <div id="ins-spark">Loading…</div>
          </section>
          <section class="ins-card">
            <h3>Unused features</h3>
            <div id="ins-unused">Loading…</div>
          </section>
          <section class="ins-card">
            <h3>Slow refresh hotspots (>200 ms)</h3>
            <div id="ins-perf">Loading…</div>
          </section>
        </div>
      </div>
      <div class="mdv-modal-foot">
        <button class="btn-blue-ghost" id="ins-open-raw">Open raw events</button>
        <button class="btn-blue-ghost" id="ins-open-folder">Open log folder</button>
        <button class="btn-blue" id="ins-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.mdv-modal-close').onclick = close;
  overlay.querySelector('#ins-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  let snap = null;
  try { snap = await api.analyticsSnapshot({ days: 30 }); }
  catch (err) {
    overlay.querySelector('#ins-top').textContent = 'Failed to load analytics: ' + (err?.message || err);
    return;
  }
  if (!snap || snap.disabled) {
    overlay.querySelector('.ins-grid').innerHTML = `
      <div class="ins-disabled">
        <h3>Telemetry is disabled</h3>
        <p>Enable <b>Anonymous telemetry</b> in Settings → Privacy to start collecting local
        usage patterns. No data leaves your machine — events go to a JSONL file in
        the user-data folder.</p>
      </div>
    `;
    return;
  }

  document.getElementById('ins-meta').textContent =
    `${snap.totalEvents} events · ${snap.sessionCount} sessions · log: ${snap.logPath ? '✓' : '–'}`;

  renderTopCommands(document.getElementById('ins-top'), snap);
  renderSparkline(document.getElementById('ins-spark'), snap);
  renderUnused(document.getElementById('ins-unused'), snap);
  renderPerf(document.getElementById('ins-perf'), snap);

  overlay.querySelector('#ins-open-raw').onclick = async () => {
    try { await api.analyticsOpenLog(); } catch (e) { window.toast?.error?.('Could not open log file'); }
  };
  overlay.querySelector('#ins-open-folder').onclick = async () => {
    try { await api.analyticsOpenLogDir(); } catch (e) { window.toast?.error?.('Could not open log folder'); }
  };
}

window.MDVInsights = { open: openInsights };
