# MD Viewer — User Manual

Welcome. MD Viewer is a focused, fast Markdown editor with built-in
review comments (via [Sidemark](https://sidemark.org)).

## Quick links

- [Quick start](./quick-start.md)
- [Keyboard shortcuts](./shortcuts.md)
- [Settings](./settings.md)
- [Changelog](../CHANGELOG.md)

## What's it for?

MD Viewer is built for people who:

- Keep a folder of Markdown notes (a "second brain", project docs,
  meeting notes, customer briefs).
- Want WYSIWYG-style editing — no toggling between source and
  preview.
- Sometimes need to leave **review comments** on documents others
  will read (or that future-you will read).

## A 60-second tour

1. **Open folder** (top-left) and pick the directory containing your
   notes. The tree on the left lists every `.md` file (and image)
   inside.
2. **Click any file** to open it. Type to edit — headings, lists,
   tables, links, and code blocks all "just work".
3. **Right-click in the editor** to add a Sidemark comment. Comments
   are stored alongside the file as `<name>.md.review.yaml`.
4. **Ctrl+P** opens the quick switcher. **Ctrl+Shift+F** searches
   the whole folder. **Ctrl+F** searches the open file.
5. **Drag images** straight from the tree into the editor — or
   paste/drop them from anywhere.

## Where things live

- Your files: wherever you opened the folder from.
- Sidemark comments: next to each `.md` as `<name>.md.review.yaml`.
- App settings: `%APPDATA%/MD Viewer/settings.json`.
- Autosave drafts: `%APPDATA%/MD Viewer/drafts/`.
- Logs (for diagnostics): About → "Open logs folder".

## Help / feedback

- Hit ⓘ (About) → "Copy diagnostics" if you need to share what
  version + environment you're on.
- Sidemark spec: <https://sidemark.org>.
