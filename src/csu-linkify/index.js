// src/csu-linkify/index.js — auto-linkify CSU/MSX/eSXP IDs in MD Viewer.
//
// Inspired by Sherpa's Docsify msx_ids: frontmatter pattern. Implementation is
// a Milkdown plugin that registers a ProseMirror Decoration set, so insertions
// are non-destructive — they never round-trip into the saved markdown.
//
// Conservative-by-default match policy:
//   - 7-XXXXXXXXX            → MSX opportunity number (auto-detected anywhere)
//   - TPID:<num>             → MSX account by salesId (explicit prefix)
//   - CSP:<guid|slug>        → eSXP success plan (explicit prefix; needs csu_ids)
//   - AGR:<guid>             → MSX agreement (explicit prefix)
//   - MSX:<guid>             → raw MSX entityrecord (explicit prefix; needs csu_ids)
//
// Frontmatter format (Sherpa Docsify-compatible — unquoted only):
//
//   ---
//   csu_ids:
//     opp 7-ABC12345: 11111111-2222-3333-4444-555555555555
//     account TPID:12345678: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
//     csp acme-fy26: 99999999-8888-7777-6666-555555555555
//   ---
//
// Both `csu_ids:` and `msx_ids:` are accepted; csu_ids wins on conflict.

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { parseFrontmatter, findMatchesInText, resolveId } from './patterns.js';

export { parseFrontmatter, findMatchesInText, resolveId };

// ---------- ProseMirror plugin ----------------------------------------------

const csuKey = new PluginKey('csu-linkify');

function buildDecorations(doc, ids) {
  const decos = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText) return true;
    if (parent && parent.type) {
      const pn = parent.type.name;
      if (pn === 'code_block' || pn === 'fence') return false;
    }
    const marks = node.marks || [];
    for (const mk of marks) {
      const n = mk.type && mk.type.name;
      if (n === 'code' || n === 'link') return false;
    }
    const text = node.text || '';
    const matches = findMatchesInText(text, ids);
    for (const m of matches) {
      decos.push(Decoration.inline(pos + m.from, pos + m.to, {
        class: `csu-link csu-link--${m.type.toLowerCase()} csu-link--${m.source}`,
        'data-csu-url': m.url,
        'data-csu-type': m.type,
        'data-csu-source': m.source,
        title: `${m.type} · ${m.source === 'mapped' ? 'mapped via csu_ids' : 'search'} · click to open`,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const STATE = { ids: new Map(), enabled: true, version: 0 };

export function setLinkifyIds(ids) {
  STATE.ids = ids instanceof Map ? ids : new Map();
  STATE.version++;
}
export function setLinkifyEnabled(on) {
  STATE.enabled = !!on;
  STATE.version++;
}
export function getLinkifyState() { return { ids: new Map(STATE.ids), enabled: STATE.enabled, version: STATE.version }; }

function csuPmPlugin() {
  return new Plugin({
    key: csuKey,
    state: {
      init: (_cfg, state) => ({
        version: STATE.version,
        decos: STATE.enabled ? buildDecorations(state.doc, STATE.ids) : DecorationSet.empty,
      }),
      apply(tr, prev, _oldState, newState) {
        const reset = tr.getMeta(csuKey);
        if (reset || prev.version !== STATE.version) {
          return {
            version: STATE.version,
            decos: STATE.enabled ? buildDecorations(newState.doc, STATE.ids) : DecorationSet.empty,
          };
        }
        if (tr.docChanged) {
          return {
            version: prev.version,
            decos: STATE.enabled ? buildDecorations(newState.doc, STATE.ids) : DecorationSet.empty,
          };
        }
        return prev;
      },
    },
    props: {
      decorations(state) { return this.getState(state)?.decos || null; },
      handleClickOn(view, _pos, _node, _nodePos, event) {
        const t = event.target;
        if (!t || !t.classList || !t.classList.contains('csu-link')) return false;
        const url = t.getAttribute('data-csu-url');
        if (!url) return false;
        event.preventDefault();
        try {
          if (window.api && typeof window.api.openExternal === 'function') window.api.openExternal(url);
          else window.open(url, '_blank');
        } catch { try { window.open(url, '_blank'); } catch {} }
        return true;
      },
    },
  });
}

// ---------- Crepe feature factory -------------------------------------------

// Returns a function that Crepe.addFeature() invokes with the editor.
// The function uses Milkdown's editor.use() to register a plugin which appends
// our ProseMirror plugin into prosePluginsCtx.
export function createCsuLinkifyFeature() {
  return (editor) => {
    if (!editor || typeof editor.use !== 'function') return;
    const milkdownPlugin = (ctx) => async () => {
      const { prosePluginsCtx } = await import('@milkdown/core');
      ctx.update(prosePluginsCtx, (prev) => prev.concat([csuPmPlugin()]));
    };
    editor.use(milkdownPlugin);
  };
}

// Convenience: parse markdown frontmatter and update the live ids map.
export function configureFromMarkdown(md) {
  const { ids } = parseFrontmatter(md);
  setLinkifyIds(ids);
  return ids;
}
