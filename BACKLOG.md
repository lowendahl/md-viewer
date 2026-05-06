# MD Viewer — Backlog

Pending enhancements and known issues.

## Open items

_None — the V1.3.x backlog (comment overlay controls, auto-refresh,
freeze, find-bar regression, image preview, "Open location") shipped
in V1.4.0. Add new items below as they come up._

## Shipped — V1.4.0 (2026-05-06)

1. ✅ **Comment overlay visibility controls** — Settings + 💬 cycle button.
2. ✅ **Auto-refresh on external change** — silent reload when clean,
   warning toast when dirty.
3. ✅ **Occasional freeze** — MRSF re-render moved to `requestIdleCallback`
   + slow-refresh hotspots surfaced in Insights.
4. ✅ **"Always open" Find-in-file regression** — CSS specificity fix
   (`#find-bar.hidden`) + idempotent installer.
5. ✅ **View image broken** — custom `mdv-img://` protocol restores
   preview around Chromium's `file://` cross-origin block.
6. ✅ **"Open location" context menu** — files / images / folders.

Plus: 📊 **Insights** panel (local usage analytics → backlog suggestions).
