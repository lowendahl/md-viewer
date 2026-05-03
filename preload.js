const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadTree: (root) => ipcRenderer.invoke('load-tree', root),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, c) => ipcRenderer.invoke('write-file', p, c),
  readSidecar: (p) => ipcRenderer.invoke('read-sidecar', p),
  writeSidecar: (p, doc) => ipcRenderer.invoke('write-sidecar', p, doc),
  deleteSidecar: (p) => ipcRenderer.invoke('delete-sidecar', p),
  getUser: () => ipcRenderer.invoke('get-user'),
  onFsEvent: (cb) => ipcRenderer.on('fs-event', (_, payload) => cb(payload)),
  onTreeDirty: (cb) => ipcRenderer.on('tree-dirty', () => cb()),
  onOpenMdFromOs: (cb) => ipcRenderer.on('open-md-from-os', (_, p) => cb(p)),
  onToast: (cb) => ipcRenderer.on('toast', (_, t) => cb(t)),
  // Wave 1: Find & Connect
  listMdFiles: () => ipcRenderer.invoke('list-md-files'),
  searchText: (opts) => ipcRenderer.invoke('search-text', opts),
  findBacklinks: (target) => ipcRenderer.invoke('find-backlinks', target),
  resolveWikilink: (name) => ipcRenderer.invoke('resolve-wikilink', name),
  getFolderStats: (p) => ipcRenderer.invoke('get-folder-stats', p),
  createMdFile: (opts) => ipcRenderer.invoke('create-md-file', opts),
  createFolder: (p) => ipcRenderer.invoke('create-folder', p),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('rename-path', oldPath, newPath),
  deletePath: (p) => ipcRenderer.invoke('delete-path', p),
  showInExplorer: (p) => ipcRenderer.invoke('show-in-explorer', p),
  // Image embedding
  saveImage: (mdPath, buffer, name, mimeType) => ipcRenderer.invoke('save-image', mdPath, buffer, name, mimeType),
  docDir: (mdPath) => ipcRenderer.invoke('doc-dir', mdPath),
  // v1.3.0
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  draftSave: (p, content) => ipcRenderer.invoke('draft:save', p, content),
  draftGet: (p) => ipcRenderer.invoke('draft:get', p),
  draftClear: (p) => ipcRenderer.invoke('draft:clear', p),
  draftList: () => ipcRenderer.invoke('draft:list'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appOpenPath: (p) => ipcRenderer.invoke('app:open-path', p),
  manualList: () => ipcRenderer.invoke('manual:list'),
  manualRead: (n) => ipcRenderer.invoke('manual:read', n),
  changelogRead: () => ipcRenderer.invoke('changelog:read'),
  printToPdf: (suggestedName) => ipcRenderer.invoke('print:pdf', suggestedName),
  startDrag: (p) => ipcRenderer.send('start-drag', p),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  updatesState: () => ipcRenderer.invoke('updates:state'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('updates:state', h); return () => ipcRenderer.removeListener('updates:state', h); },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setLastFile: (info) => ipcRenderer.invoke('lastfile:set', info),
});

// Feature flags surfaced from main via additionalArguments.
// Each --mdv-flag=name appears in process.argv.
const FLAGS = {
  tree:     process.argv.includes('--mdv-flag=tree'),
  editor:   process.argv.includes('--mdv-flag=editor'),
  comments: process.argv.includes('--mdv-flag=comments'),
  changes:  process.argv.includes('--mdv-flag=changes'),
};
contextBridge.exposeInMainWorld('__MDV_FLAGS__', FLAGS);

// Observability surface — inlined here because preload runs sandboxed,
// which restricts require() to a tiny whitelist (no workspace packages).
// Mirrors @compass/observability/preload exposeObsBridge().
contextBridge.exposeInMainWorld('obs', {
  emit: (event) => ipcRenderer.invoke('obs:emit', event),
  logPath: () => ipcRenderer.invoke('obs:logPath'),
  openLogDir: () => ipcRenderer.invoke('obs:openLogDir'),
  openLogFile: () => ipcRenderer.invoke('obs:openLogFile'),
  readEvents: (opts) => ipcRenderer.invoke('obs:readEvents', opts),
  listLogDates: () => ipcRenderer.invoke('obs:listLogDates'),
  meta: () => ipcRenderer.invoke('obs:meta'),
});

