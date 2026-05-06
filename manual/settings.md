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

## CSU / MSX links

- **Auto-linkify CSU/MSX/eSXP IDs** — when on, MD Viewer underlines
  these patterns and turns them into clickable links:

  | Pattern              | Linked to                                                                             |
  |----------------------|---------------------------------------------------------------------------------------|
  | `7-XXXXXXXXX`        | MSX opportunity (auto-detected anywhere in the doc)                                   |
  | `TPID:<num>`         | MSX account (search, or direct record if mapped via `csu_ids:`)                       |
  | `CSP:<guid\|slug>`   | eSXP success plan (needs a `csu_ids:` entry unless the value is already a GUID)       |
  | `AGR:<guid>`         | MSX agreement record                                                                  |
  | `MSX:<guid>`         | Raw MSX entityrecord lookup                                                           |

  The decoration is **non-destructive** — only an underline overlay is
  added; the saved Markdown is unchanged. Disable per session in
  Settings; persists globally.

- **`csu_ids:` frontmatter** — map slugs to GUIDs at the top of any
  doc. Sherpa's `msx_ids:` is also accepted. Use unquoted values:

  ```yaml
  ---
  csu_ids:
    opp 7-ABC12345: 11111111-2222-3333-4444-555555555555
    account TPID:12345678: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    csp acme-fy26: 99999999-8888-7777-6666-555555555555
  ---
  ```

  Without a mapping, `7-XXX` and `TPID:<num>` fall back to MSX
  search URLs; `CSP:`, `AGR:`, `MSX:` need either a `csu_ids:` entry
  or a literal GUID.

## Data folders

About → "Open data folder" / "Open logs folder" jump to:

- `userData` — `%APPDATA%/MD Viewer/`
- `logs` — `%APPDATA%/MD Viewer/logs/`
