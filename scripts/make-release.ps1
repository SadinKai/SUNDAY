$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $securityModule -Force -ErrorAction Stop
$utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
Import-Module $utilityModule -Force -ErrorAction Stop

# Produce a portable archive and an inventory for manual artifact
# qualification. This intentionally does not create latest.yml: the SUNDAY Launcher
# automatic updater is disabled until it has an independently signed manifest,
# anti-rollback state, side-by-side activation, health checking, and rollback.

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'dist'
$portableDir = Join-Path $releaseDir 'Sunday'
$installer = Join-Path $releaseDir 'SundayInstaller.exe'
$uninstaller = Join-Path $releaseDir 'SundayUninstall.exe'
$launcherExe = Join-Path $portableDir 'Sunday.exe'
$nodeExe = Join-Path $portableDir 'node.exe'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$requireSigning = $env:SUNDAY_REQUIRE_SIGNING -eq '1'

foreach ($file in @($installer, $uninstaller, $launcherExe, $nodeExe)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Required release input is missing: $file" }
  if ($requireSigning) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid') {
      throw "Release input is not validly signed: $file ($($signature.Status))."
    }
  }
}

$allowedPortableTopLevel = @('Sunday.exe', 'node.exe', 'src', 'node_modules')
$unexpectedPortableItems = @(Get-ChildItem -LiteralPath $portableDir -Force |
  Where-Object { $allowedPortableTopLevel -notcontains $_.Name })
if ($unexpectedPortableItems.Count -ne 0) {
  $names = ($unexpectedPortableItems | ForEach-Object Name) -join ', '
  throw "Portable tree contains runtime or unknown top-level content and will not be released: $names"
}
$portableReparsePoints = @(Get-ChildItem -LiteralPath $portableDir -Recurse -Force |
  Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($portableReparsePoints.Count -ne 0) {
  throw "Portable tree contains a reparse point and will not be released: $($portableReparsePoints[0].FullName)"
}

$portable = Join-Path $releaseDir "SundayPortable_${version}_x64.zip"
Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $portable -Force

$files = @($installer, $portable, $launcherExe, $nodeExe, $uninstaller) | ForEach-Object {
  $item = Get-Item -LiteralPath $_
  $signature = if ($item.Extension -eq '.exe') { Get-AuthenticodeSignature -LiteralPath $item.FullName } else { $null }
  $releasePrefix = [IO.Path]::GetFullPath($releaseDir).TrimEnd('\') + '\'
  $fullPath = [IO.Path]::GetFullPath($item.FullName)
  if (-not $fullPath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release artifact escaped the release directory: $fullPath"
  }
  [ordered]@{
    name = $item.Name
    relativePath = $fullPath.Substring($releasePrefix.Length)
    size = $item.Length
    sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticodeStatus = if ($signature) { [string]$signature.Status } else { $null }
    signerSubject = if ($signature -and $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  }
}

$inventory = [ordered]@{
  schemaVersion = 1
  product = 'SUNDAY Launcher'
  version = $version
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  updaterActivation = 'UNAVAILABLE'
  files = @($files)
}
$inventoryPath = Join-Path $releaseDir 'release-inventory.json'
[IO.File]::WriteAllText(
  $inventoryPath,
  ($inventory | ConvertTo-Json -Depth 6),
  (New-Object Text.UTF8Encoding($false))
)

Write-Host "Wrote $portable"
Write-Host "Wrote $inventoryPath"
Write-Host 'No automatic-update feed was generated.'
