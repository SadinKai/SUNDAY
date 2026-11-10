$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'dist\Sunday'
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$releaseExe = Join-Path $root 'src-tauri\target\release\Sunday.exe'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.23\.\d+$') { throw 'The release requires Node 22.23.x.' }

if (-not (Test-Path $tauri)) { throw 'Tauri CLI is not installed. Run npm install first.' }

Write-Host 'Building Tauri release...'
& $tauri build -- --locked
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }
if (-not (Test-Path $releaseExe)) { throw 'Tauri release executable was not created.' }

Write-Host "Cleaning $out"
$expectedOut = [IO.Path]::GetFullPath((Join-Path $root 'dist\Sunday'))
if ([IO.Path]::GetFullPath($out) -ne $expectedOut -or -not $expectedOut.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\')) { throw 'Unexpected portable output directory.' }
if (Test-Path $out) {
  if ((Get-Item -LiteralPath $out).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable output is a link.' }
  Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item $releaseExe (Join-Path $out 'Sunday.exe') -Force
Copy-Item $nodeExe (Join-Path $out 'node.exe') -Force

# Temporary compatibility staging while the remaining JS service layer is
# ported to Rust. The Tauri shell is active; only the transitional Node
# backend is copied next to the portable executable.
New-Item -ItemType Directory -Force (Join-Path $out 'src') | Out-Null
$runtimeFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-files.json') -Raw | ConvertFrom-Json
if ($runtimeFiles.Count -eq 0 -or @($runtimeFiles | Sort-Object -Unique).Count -ne $runtimeFiles.Count) { throw 'Runtime allowlist is empty or contains duplicates.' }
$runtimeDestination = Join-Path $out 'src\main'
New-Item -ItemType Directory -Force $runtimeDestination | Out-Null
foreach ($file in $runtimeFiles) {
  if ($file -notmatch '^[a-z][a-z0-9-]*\.js$' -or $file -eq 'launch-plan-recovery.js') { throw 'Invalid production runtime allowlist entry.' }
  Copy-Item -LiteralPath (Join-Path (Join-Path $root 'src\main') $file) -Destination (Join-Path $runtimeDestination $file) -ErrorAction Stop
}
New-Item -ItemType Directory -Force (Join-Path $out 'node_modules') | Out-Null
$prodDirs = & npm.cmd ls --omit=dev --all --parseable 2>$null
$modulesRoot = Join-Path $root 'node_modules'
foreach ($dep in $prodDirs) {
  if (-not $dep -or $dep -eq $root -or -not $dep.StartsWith($modulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $relative = $dep.Substring($modulesRoot.Length).TrimStart('\')
  if (-not $relative) { continue }
  robocopy $dep (Join-Path (Join-Path $out 'node_modules') $relative) /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

Write-Host ""
Write-Host "Built SUNDAY Launcher: $(Join-Path $out 'Sunday.exe')"
Write-Host 'Run it directly, or zip dist\Sunday as a portable distribution.'
