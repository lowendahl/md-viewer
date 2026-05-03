# release.ps1 — bump version, commit, tag, build, and publish to GitHub Releases.
# Usage: .\release.ps1 -Version 1.3.3 -Notes "Fixed X, added Y"
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1. Bump package.json version
$pkgPath = Join-Path $PSScriptRoot "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
($pkg | ConvertTo-Json -Depth 32) | Set-Content $pkgPath -Encoding utf8
Write-Host "✓ package.json bumped to $Version"

# 2. Prepend a CHANGELOG entry (skipped if -Notes empty)
if ($Notes) {
  $clPath = Join-Path $PSScriptRoot "CHANGELOG.md"
  $today = (Get-Date -Format "yyyy-MM-dd")
  $entry = "## [$Version] — $today`r`n`r`n$Notes`r`n`r`n"
  $existing = Get-Content $clPath -Raw
  $marker = "Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)."
  $new = $existing -replace [regex]::Escape($marker), "$marker`r`n`r`n$entry"
  Set-Content $clPath -Value $new -Encoding utf8
  Write-Host "✓ CHANGELOG.md updated"
}

# 3. Commit + push
git add -A
git commit -m "v$Version$(if ($Notes) { ': ' + ($Notes -split "`n")[0] })" | Out-Null
git push
Write-Host "✓ Pushed to origin/main"

# 4. Build + publish (electron-builder creates GitHub release + uploads assets)
$env:GH_TOKEN = (gh auth token)
npm run release
Write-Host "✓ Released v$Version — installed clients will auto-update on next launch"
