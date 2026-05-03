# MD Viewer — Changelog

All notable changes to MD Viewer.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
