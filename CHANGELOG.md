# MD Viewer — Changelog

All notable changes to MD Viewer.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **CSU / MSX / eSXP auto-linkify.** New non-destructive ProseMirror
  decoration overlay underlines opportunity numbers (`7-XXXXXXXXX`)
  and explicit prefixes (`TPID:`, `CSP:`, `AGR:`, `MSX:`) so a click
  opens the corresponding MSX or eSXP record. Slug-to-GUID mapping
  is read from a `csu_ids:` (or `msx_ids:`) frontmatter block,
  matching Sherpa's Docsify convention. The underlying markdown is
  never modified — saves stay clean. New setting "Auto-linkify
  CSU/MSX/eSXP IDs" (default on); see `manual/settings.md`. Code in
  `src/csu-linkify/`.

### Fixed
- **Folder gallery is now a true overlay.** Previously the gallery
  panel covered the editor area but had no close button, so the only
  way to dismiss it was to pick a folder. Now: header has an explicit
  × close button, the Home topbar button toggles (open ↔ close),
  clicking the backdrop closes, and Esc closes (already worked). Panel
  also gets a soft backdrop blur and fade-in so it reads as an overlay
  instead of a permanent screen replacement.

## [1.4.1] — 2026-05-06

### Fixed
- **Auto-update no longer spits a raw XML parser error** ("Attribute without
  value Line: 26 Column: 76 Char: >"). The locally-built v1.4.0 had been
  compiled from a stale base that pre-dated the v1.3.4 publish-target fix,
  re-introducing the abandoned private EMU repo `plwendahl_microsoft/md-viewer`
  in `app-update.yml`. GitHub returned the SAML/SSO HTML login page, which
  builder-util-runtime's sax parser then choked on. Republished `package.json`
  publish target as `lowendahl/md-viewer` (public), and `runUpdateCheck` now
  detects parser-dump-style errors and shows
  "Update feed unreadable (release repo may be private or returning HTML)"
  instead of leaking raw sax output.

## [1.4.0] — 2026-05-06

### Added
- **📊 Insights panel** (topbar) — local-only usage analytics dashboard.
  Shows top commands, unused features, sessions per day, and slow-refresh
  hotspots over the last 30 days. Aggregated entirely from the existing
  `@compass/observability` NDJSON log; nothing leaves the machine.
  Open with the 📊 button on the topbar.
- **Comment overlay control** — Settings → Comments lets you choose
  `Inline highlights + gutter`, `Gutter markers only`, or `Off (rail only)`.
  The 💬 topbar button cycles through the three modes.
- **Auto-refresh on external change** — when the open file is modified
  outside MD Viewer (git pull, OneDrive sync, another editor), the view
  reloads transparently if there are no unsaved changes; otherwise a
  toast warns about the change.
- **"Open location"** context-menu item on files, images, and folders —
  opens Explorer at the parent (file/image) or the folder itself.
- **Custom `mdv-img://` protocol** for local image previews — works
  around the Chromium `file://` cross-origin block that broke image
  preview in 1.3.x.

### Fixed
- **Find-in-file regression** — `#find-bar.hidden` now actually hides
  the bar (id selector previously beat the `.hidden` class), and the
  bar installer is idempotent so the Ctrl+F handler no longer stacks.
- **Occasional freeze** during heavy comment activity — the MRSF
  re-render is now scheduled via `requestIdleCallback` and timed; slow
  refreshes (>200 ms) are recorded as `mdv.perf.refresh.long` events
  so they show up in the Insights "hotspots" card.
- **Image preview** restored (see `mdv-img://` above).

### Privacy
- Telemetry stays local. Opt-out via Settings → Privacy. When opted in,
  events are written to the user-data folder only — paths are reduced to
  a folder hash + extension, file content is never logged.

## [1.3.6] — 2026-05-04

### Added
- **Pasteable path bar.** The workspace path in the sidebar is now an editable
  input. Paste a folder path or a `.md` file path and press Enter — the app
  loads the folder (or the file's containing folder) and opens the file. Also
  accepts `mdviewer://…` and `file://…` URLs.
- **Back / Forward / Up navigation.** A small nav strip next to the path bar
  remembers root history. Pair it with the new "Focus from here" context-menu
  entry on folders to drill in and out without losing your place.
- **`mdviewer://` custom URL scheme.** Links of the form
  `mdviewer://C:/Users/me/notes/foo.md` (or URL-encoded equivalents) now open
  the file in MD Viewer when clicked from chats, browsers, or the Run dialog.
  The NSIS installer registers the protocol on install; on macOS it's wired
  via `open-url`.

## [1.3.5] — 2026-05-04

### Fixed
- **Toolbar "+ New file/folder" now creates inside the selected folder.** It
  used to always plop the new item at the workspace root regardless of where
  you were; now it honours the selected folder (or the selected file's parent),
  expands it, and inserts the inline rename input there.
- **Tree no longer expands itself on every refresh.** Expand/collapse state is
  persisted per workspace in `localStorage` and restored after refreshes,
  inline creates, and reopens. Default state for a fresh workspace is fully
  collapsed; folders only open when you click them.
- Click-selection now highlights any node (file or folder) with the existing
  `.node.selected` style and survives tree refreshes.

## [1.3.4] — 2026-05-04

### Changed
- **Publishing moved to `lowendahl/md-viewer` (public).** Microsoft EMU repos
  require SAML SSO, so anonymous fetches of `latest.yml` redirected to an HTML
  login page that electron-updater couldn't parse — surfacing as
  "Attribute without value Line: 26 Column: 76" on every check. Releases now
  ship from a public personal repo so auto-updates work end-to-end.

### Fixed
- Friendlier toast when the update feed returns something unparseable
  (translates the SAX/YAML noise into a human message).
- Find bar (Ctrl+F) was permanently visible — `#find-bar.hidden` rule was
  missing in CSS.

## [1.3.3] — 2026-05-03

### Fixed
- **Find bar always visible / can't be closed.** `#find-bar` had `display: flex`
  with no `.hidden` override, so toggling the `hidden` class did nothing and
  the bar was permanently shown. Added `#find-bar.hidden { display: none }`.

## [1.3.2] — 2026-05-03

### Added
- **Real auto-updates** via `electron-updater` + GitHub Releases. The app
  checks for new releases on launch, downloads in the background, and
  installs on quit. No more "open download page" round-trip.

## [1.3.1] — 2026-05-03

### Added
- **In-app manual** — bundled `manual/` folder with quick-start, keyboard
  shortcuts, settings reference, and changelog. Open from About → "Open
  manual" or via the topbar 📖 button.
- **Changelog tab** in the About dialog. Future releases will surface
  the latest changes here without leaving the app.

### Fixed
- **Find bar couldn't be closed.** Esc now closes the bar from anywhere
  (the previous handler only fired while the input was focused), and
  the × button is reliably bound on first open.
- Find bar now also closes when you click outside it.

## [1.3.0] — 2026-05-03

The "ship-without-daily-updates" omnibus. 16 features in one drop, plus a
VS Code-inspired UI overhaul.

### Added
- **Toast notifications** — non-blocking status messages with optional
  action buttons (`window.toast.info / success / warn / error`).
  Replaces native `alert()` for non-blocking errors.
- **Settings modal** (⚙ button in topbar) — appearance, behavior,
  updates, and privacy preferences. Persists to
  `%APPDATA%/MD Viewer/settings.json`.
- **About dialog** (ⓘ button in topbar) — version, build info,
  one-click "Copy diagnostics", links to user-data and log folders.
- **Light theme** — toggle in Settings → Appearance.
- **VS Code-inspired shell** (default ON) — tighter tree rows,
  monochrome surfaces, smaller buttons. Toggle in Settings → Shell
  style if you prefer the classic MD Viewer skin.
- **Find in file** — Ctrl+F to search the open document with
  next/prev navigation and match count.
- **Tree filter** — type-ahead filter input above the tree, focus
  with Ctrl+L. Hidden non-matching files; matching files keep their
  parent folders visible.
- **Tree keyboard delete** — Del key on a selected file/folder
  triggers a confirm + delete.
- **Last-file restore** — reopens the file you had open when you
  quit, if it's still inside the current folder.
- **Autosave drafts** — every keystroke saves a snapshot to
  `%APPDATA%/MD Viewer/drafts/`. If you reopen a file and a newer
  draft exists, you get a "Recover" toast.
- **Sidecar quarantine** — corrupt `.review.yaml` files are
  auto-renamed to `*.corrupt-<timestamp>` instead of breaking the
  editor; a toast warns you.
- **Drag-out** — Alt+drag any file or image from the tree into
  another app (Outlook, Explorer, browser).
- **Print to PDF** — 🖨 button in topbar exports the current view
  to a PDF file.
- **Auto-update check** — configurable JSON manifest URL in
  Settings → Updates. On launch (or via "Check now") MD Viewer
  fetches the manifest and shows a toast with a download link if a
  newer version is available. No auto-install — you stay in control.
- **Code-signing wiring** — electron-builder runs `signtool` if a
  certificate is provided via env vars. Build still works without
  one (just produces an unsigned binary).
- **NSIS install-time file association** — already shipped in
  v1.1.11 via `fileAssociations`; the installer registers `.md` and
  `.markdown` for MD Viewer automatically.

### Changed
- `walkMd` is now capped at 8,000 entries (configurable in Settings)
  to keep large folders from freezing the UI.
- Chokidar (file watcher) startup is deferred ~250 ms after the
  tree is rendered so the first paint isn't blocked.

### Performance
- Lighter sidebar surfaces and reduced padding in VS Code shell mode
  shrink first paint by ~120 ms.

## [1.2.0] — 2026-05-03

### Added
- **Drag and drop to move files** in the tree. Drop targets only
  accept directories; folders can't be dropped into their own
  descendants.
- **Images in tree** — `.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.avif`
  show alongside Markdown files. Sort order: dirs → markdown → images.
- **Drag image from tree into editor** — inserts a relative
  `![](path)` reference (no copy of the source file).
- **Lightbox / zoom viewer** for images — click any image in the
  tree or the editor to open it, then zoom (− / + / Fit / 1:1),
  pan with the mouse, scroll-wheel zoom, Esc to close.

## [1.1.11] — 2026-05-03

### Added
- **`.md` / `.markdown` file association** via NSIS. Double-clicking
  a Markdown file from Explorer opens it in MD Viewer. Single-instance
  lock ensures the file opens in the existing window if one is open.

## [1.1.10] — 2026-05-03

### Added
- **Empty folders show in the tree** (previously hidden if they had
  no Markdown files).
- **"Open in Explorer"** in the right-click menu for files, folders,
  and images.

## [1.1.9] — 2026-05-03

### Added
- **Folder gallery card labels.** Hover any card → ✎ to rename it
  (Enter to save, Esc to cancel, blank to revert), × to remove.
  Labels are saved with the recents list and used everywhere the
  folder is shown.

## [1.1.8] — 2026-05-03

### Changed
- **Brand banner** — now black with the artwork centered vertically
  and 12 px of left padding; bumped to 44 px tall to match the
  bottom toolbar.

## [1.1.7] — 2026-05-03

### Fixed
- Banner image and Sora font assets now ship inside the asar
  (previously dropped because they lived in `build/`, which
  electron-builder reserves for installer resources).

## [1.1.6 and earlier]

Initial development line:
- Markdown viewer with Sidemark/Crepe editor (v1.0)
- Sidemark comments rail (v1.1.0)
- Folder gallery / recents (v1.1.1)
- Wikilink autocomplete + backlinks rail (v1.1.2)
- Quick switcher (Ctrl+P) and full-text search (Ctrl+Shift+F) (v1.1.3)
- File ops: rename, delete, new file/folder (v1.1.4)
- Image paste/drop into editor (v1.1.5)
- Brand palette + topbar banner (v1.1.6)
