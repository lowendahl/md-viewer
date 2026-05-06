// src/csu-linkify/patterns.js — pure functions: frontmatter parse, regex,
// URL resolver, match finder. No editor / DOM dependencies, so this file is
// directly testable in plain Node.

const MSX_OPP_RE = /\b7-[A-Z0-9]{8,12}\b/g;
const PREFIXED_RE = /\b(TPID|CSP|AGR|MSX):([A-Za-z0-9][A-Za-z0-9-]{0,80})/g;
const MSX_BASE = 'https://msxplatform.crm.dynamics.com';
const ESXP_BASE = 'https://esxp.microsoft.com';

function msxRecordUrl(entity, guid) {
  return `${MSX_BASE}/main.aspx?etn=${encodeURIComponent(entity)}&pagetype=entityrecord&id=${encodeURIComponent(guid)}`;
}
function msxAccountSearchUrl(tpid) {
  return `${MSX_BASE}/main.aspx?pagetype=entitylist&etn=account&viewType=4230&extraqs=${encodeURIComponent('?$filter=accountnumber eq \'' + tpid + '\'')}`;
}
function msxOppSearchUrl(oppNum) {
  return `${MSX_BASE}/main.aspx?pagetype=entitylist&etn=opportunity&viewType=4230&extraqs=${encodeURIComponent('?$filter=name eq \'' + oppNum + '\'')}`;
}
function esxpSuccessPlanUrl(guid) {
  return `${ESXP_BASE}/successPlans/${encodeURIComponent(guid)}`;
}

const FM_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export function parseFrontmatter(md) {
  if (typeof md !== 'string') return { ids: new Map(), body: md ?? '' };
  const m = md.match(FM_RE);
  if (!m) return { ids: new Map(), body: md };
  const block = m[1];
  const ids = new Map();
  const lines = block.split(/\r?\n/);
  let inMap = false;
  let mapIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    const topMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/);
    if (topMatch) {
      const key = topMatch[1].toLowerCase();
      inMap = key === 'csu_ids' || key === 'msx_ids';
      mapIndent = -1;
      continue;
    }
    if (!inMap) continue;
    const im = line.match(/^(\s+)(\S.*)$/);
    if (!im) { inMap = false; continue; }
    const indent = im[1].length;
    if (mapIndent < 0) mapIndent = indent;
    if (indent < mapIndent) { inMap = false; continue; }
    const rest = im[2];
    // Split on the LAST ": " so keys may themselves contain ":" (e.g. "TPID:12345678")
    let sepIdx = rest.lastIndexOf(': ');
    if (sepIdx < 0) {
      // Allow trailing ":" with no space at end-of-line as the separator too.
      if (rest.endsWith(':')) { sepIdx = rest.length - 1; }
      else continue;
    }
    const key = rest.slice(0, sepIdx).trim();
    const val = rest.slice(sepIdx + 1).trim();
    if (!key || !val) continue;
    ids.set(key.toLowerCase(), val);
  }
  return { ids, body: md.slice(m[0].length) };
}

export function resolveId(rawText, ids) {
  const idsMap = ids instanceof Map ? ids : new Map();
  const lookup = (...keys) => {
    for (const k of keys) {
      if (!k) continue;
      const v = idsMap.get(String(k).toLowerCase());
      if (v) return v;
    }
    return null;
  };
  const isGuid = (s) => /^[0-9a-f-]{36}$/i.test(s);

  const pre = rawText.match(/^(TPID|CSP|AGR|MSX):(.+)$/i);
  if (pre) {
    const type = pre[1].toUpperCase();
    const value = pre[2];
    if (type === 'TPID') {
      const guid = lookup(`tpid:${value}`, `account tpid:${value}`, `account ${value}`, value);
      if (guid && isGuid(guid)) return { url: msxRecordUrl('account', guid), type, label: rawText, source: 'mapped' };
      if (/^\d+$/.test(value)) return { url: msxAccountSearchUrl(value), type, label: rawText, source: 'fallback' };
      return null;
    }
    if (type === 'CSP') {
      const guid = lookup(`csp:${value}`, `csp ${value}`, value);
      if (guid && isGuid(guid)) return { url: esxpSuccessPlanUrl(guid), type, label: rawText, source: 'mapped' };
      if (isGuid(value)) return { url: esxpSuccessPlanUrl(value), type, label: rawText, source: 'mapped' };
      return null;
    }
    if (type === 'AGR') {
      const guid = lookup(`agr:${value}`, `agr ${value}`, value);
      const id = (guid && isGuid(guid)) ? guid : (isGuid(value) ? value : null);
      if (id) return { url: msxRecordUrl('msdyn_agreement', id), type, label: rawText, source: 'mapped' };
      return null;
    }
    if (type === 'MSX') {
      const guid = lookup(`msx:${value}`, value);
      if (guid && isGuid(guid)) return { url: msxRecordUrl('account', guid), type, label: rawText, source: 'mapped' };
      if (isGuid(value)) return { url: msxRecordUrl('account', value), type, label: rawText, source: 'mapped' };
      return null;
    }
  }

  if (/^7-[A-Z0-9]{8,12}$/.test(rawText)) {
    const guid = lookup(`opp ${rawText}`, `opportunity ${rawText}`, rawText);
    if (guid && isGuid(guid)) return { url: msxRecordUrl('opportunity', guid), type: 'OPP', label: rawText, source: 'mapped' };
    return { url: msxOppSearchUrl(rawText), type: 'OPP', label: rawText, source: 'fallback' };
  }

  return null;
}

export function findMatchesInText(text, ids) {
  const out = [];
  if (!text) return out;
  let m;
  MSX_OPP_RE.lastIndex = 0;
  while ((m = MSX_OPP_RE.exec(text)) !== null) {
    const r = resolveId(m[0], ids);
    if (r) out.push({ from: m.index, to: m.index + m[0].length, ...r });
  }
  PREFIXED_RE.lastIndex = 0;
  while ((m = PREFIXED_RE.exec(text)) !== null) {
    const r = resolveId(m[0], ids);
    if (r) out.push({ from: m.index, to: m.index + m[0].length, ...r });
  }
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  const cleaned = [];
  let lastEnd = -1;
  for (const x of out) {
    if (x.from < lastEnd) continue;
    cleaned.push(x);
    lastEnd = x.to;
  }
  return cleaned;
}
