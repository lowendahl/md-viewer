# Settings

Open with the ⚙ button in the topbar (top-right).

Settings are stored in `%APPDATA%/MD Viewer/settings.json`.

## Appearance

- **UI theme** — Dark (default) or Light.
- **Shell style** — VS Code-inspired (default) or Classic MD Viewer.
- **UI font size** — 11–20 px.
- **Editor font size** — 12–24 px.

> Editor *content* themes (Frame / Classic / Nord) are picked from
> the topbar dropdown, not Settings. They control how rendered
> Markdown looks (fonts, headings, code blocks).

## Behavior

- **Show images in tree** — toggle whether `.png/.jpg/.svg/...`
  files appear in the tree alongside Markdown.
- **Image folder name** — when you paste/drop an image, MD Viewer
  copies it into `<doc-folder>/<image folder>/`. Default: `attachments`.
- **Max tree entries** — performance cap to prevent huge folders
  from freezing the UI. Default: 8000.
- **Ignore folder names** — comma-separated list of folder names to
  skip when scanning. Default: `node_modules, .git, .svn, .hg, dist,
  build, release`.

## Updates

MD Viewer can check a JSON manifest at a URL you configure.

- **Check for updates on launch** — runs the check ~4 s after the
  app starts.
- **Manifest URL** — must return JSON shaped like:

  ```json
  {
    "version": "1.4.0",
    "downloadUrl": "https://example.com/MD-Viewer-1.4.0-x64.exe",
    "notes": "Optional release notes."
  }
  ```

- **Check now** — runs the check on demand and shows a toast.

There is no auto-install — when an update is found you'll see a
toast with a "Download" button that opens the URL in your browser.

## Privacy

- **Anonymous telemetry** — controls the local observability
  channel. Currently nothing is sent to a server.

## Data folders

About → "Open data folder" / "Open logs folder" jump to:

- `userData` — `%APPDATA%/MD Viewer/`
- `logs` — `%APPDATA%/MD Viewer/logs/`
