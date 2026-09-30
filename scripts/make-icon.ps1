$ErrorActionPreference = 'Stop'

# Regenerates every platform icon from the canonical SUNDAY Launcher SVG, then
# keeps the installer and legacy build paths synchronized with Tauri's ICO.
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$source = Join-Path $root 'assets\logo.svg'
$tauriIco = Join-Path $root 'src-tauri\icons\icon.ico'
$tauriPng = Join-Path $root 'src-tauri\icons\icon.png'

if (-not (Test-Path -LiteralPath $tauri)) {
  throw 'Tauri CLI is missing. Run npm ci before npm run make-icon.'
}

& $tauri icon $source
if ($LASTEXITCODE -ne 0) { throw 'SUNDAY Launcher icon generation failed.' }

Copy-Item -LiteralPath $tauriIco -Destination (Join-Path $root 'installer\icon.ico') -Force
Copy-Item -LiteralPath $tauriPng -Destination (Join-Path $root 'assets\icon.png') -Force

$legacyBuildIcon = Join-Path $root 'build\icon.ico'
if (Test-Path -LiteralPath (Split-Path -Parent $legacyBuildIcon)) {
  Copy-Item -LiteralPath $tauriIco -Destination $legacyBuildIcon -Force
}

Write-Host 'Regenerated SUNDAY Launcher icons from assets\logo.svg.'
