$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $securityModule -Force -ErrorAction Stop
$utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
Import-Module $utilityModule -Force -ErrorAction Stop

# Builds the SUNDAY Launcher installer app and packs the portable distribution
# into it. The result is a single self-extracting SundayInstaller.exe - a real
# Win32 application (one dark SUNDAY-branded page, real native controls, no
# wizard) whose content swaps in place:
#   install form -> Install SUNDAY Launcher -> progress -> done.
#
# Before final signing:
#   [ sunday-setup.exe ][ zip payload ][ SUNDAYST magic ][ u64 start ]
# Authenticode appends its WIN_CERTIFICATE table; the installer locates the
# trailer at the PE security-directory file offset.

$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root 'installer'
$releaseDir = Join-Path $root 'dist'
$portableDir = Join-Path $releaseDir 'Sunday'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$requireSigning = $env:SUNDAY_REQUIRE_SIGNING -eq '1'
$signingPfx = $env:SUNDAY_CODESIGN_PFX
$signingPassword = $env:SUNDAY_CODESIGN_PASSWORD
$signtool = $null

if ($requireSigning) {
  foreach ($name in @('SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64', 'SUNDAY_RELEASE_PUBLISHER', 'SUNDAY_RELEASE_MANIFEST_URL')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
      throw "$name is required for a production release build."
    }
  }
}

if ($requireSigning -or -not [string]::IsNullOrWhiteSpace($signingPfx)) {
  if ([string]::IsNullOrWhiteSpace($signingPfx) -or -not (Test-Path -LiteralPath $signingPfx)) {
    throw 'Production signing is required, but SUNDAY_CODESIGN_PFX does not name a readable PFX file.'
  }
  if ([string]::IsNullOrWhiteSpace($signingPassword)) { throw 'SUNDAY_CODESIGN_PASSWORD is required.' }
  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction Stop |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw 'signtool.exe was not found.' }
}

function Sign-SundayFile([string]$File) {
  if (-not $signtool) {
    if ($requireSigning) { throw "Signing required for $File." }
    return
  }
  & $signtool.FullName sign /fd SHA256 /tr https://timestamp.digicert.com /td SHA256 /f $signingPfx /p $signingPassword $File
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $File ($LASTEXITCODE)." }
  & $signtool.FullName verify /pa /v $File | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Signature verification failed for $File." }
}

function Assert-SundayPublisher([string]$File) {
  if (-not $requireSigning) { return }
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "SUNDAY Launcher signature is not valid for $File."
  }
  if ($signature.SignerCertificate.Subject -cne $env:SUNDAY_RELEASE_PUBLISHER) {
    throw "SUNDAY Launcher publisher identity does not match SUNDAY_RELEASE_PUBLISHER for $File."
  }
}

# 1. Build the portable distribution (Sunday.exe + node runtime + resources).
& (Join-Path $PSScriptRoot 'build-portable.ps1')
if (-not (Test-Path (Join-Path $portableDir 'Sunday.exe'))) { throw 'Portable build did not produce Sunday.exe.' }
Sign-SundayFile (Join-Path $portableDir 'Sunday.exe')
Assert-SundayPublisher (Join-Path $portableDir 'Sunday.exe')
$nodeSignature = Get-AuthenticodeSignature (Join-Path $portableDir 'node.exe')
if ($requireSigning -and $nodeSignature.Status -ne 'Valid') { throw 'The bundled Node runtime does not have a valid Authenticode signature.' }

# 2. Build the custom installer app.
$env:SUNDAY_VERSION = $version
Push-Location $installerDir
try {
  cargo build --release --locked
  if ($LASTEXITCODE -ne 0) { throw "Installer cargo build failed ($LASTEXITCODE)." }
} finally { Pop-Location }
$setupExe = Join-Path $installerDir 'target\release\sunday-setup.exe'
if (-not (Test-Path $setupExe)) { throw 'sunday-setup.exe was not created.' }
$uninstallerExe = Join-Path $releaseDir 'SundayUninstall.exe'
Copy-Item $setupExe $uninstallerExe -Force
Sign-SundayFile $uninstallerExe
Assert-SundayPublisher $uninstallerExe

# 3. Stage the payload. Runtime prerequisites are OS-managed; never download
#    or execute an unpinned bootstrapper as part of this build.
$staging = Join-Path $releaseDir 'installer-payload'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
robocopy $portableDir $staging /E /NFL /NDL /NJH /NJS /NP | Out-Null

Copy-Item $uninstallerExe (Join-Path $staging 'uninstall.exe') -Force

# Closed-world payload manifest. The outer Authenticode signature covers this
# document and the archive bytes; the installer independently re-hashes every
# extracted file before activating the directory.
$stagingPrefix = [IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
$manifestFiles = Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
  $fullPath = [IO.Path]::GetFullPath($_.FullName)
  if (-not $fullPath.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Payload file escaped the staging directory: $fullPath"
  }
  [ordered]@{
    path = $fullPath.Substring($stagingPrefix.Length).Replace('\', '/')
    size = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} | Sort-Object path
$installManifest = [ordered]@{
  schemaVersion = 1
  product = 'SUNDAY Launcher'
  version = $version
  files = @($manifestFiles)
}
[IO.File]::WriteAllText(
  (Join-Path $staging 'sunday-install-manifest.json'),
  ($installManifest | ConvertTo-Json -Depth 5),
  (New-Object Text.UTF8Encoding($false))
)

$payloadZip = Join-Path $releaseDir 'installer-payload.zip'
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $payloadZip -CompressionLevel Optimal

# 4. Attach the payload to the installer exe.
$exeBytes = [IO.File]::ReadAllBytes($setupExe)
$zipBytes = [IO.File]::ReadAllBytes($payloadZip)
$trailer = New-Object byte[] 16
[Array]::Copy([Text.Encoding]::ASCII.GetBytes('SUNDAYST'), 0, $trailer, 0, 8)
[Array]::Copy([BitConverter]::GetBytes([Int64]$exeBytes.Length), 0, $trailer, 8, 8)

$installerExe = Join-Path $releaseDir 'SundayInstaller.exe'
$out = New-Object byte[] ($exeBytes.Length + $zipBytes.Length + 16)
[Array]::Copy($exeBytes, 0, $out, 0, $exeBytes.Length)
[Array]::Copy($zipBytes, 0, $out, $exeBytes.Length, $zipBytes.Length)
[Array]::Copy($trailer, 0, $out, $exeBytes.Length + $zipBytes.Length, 16)
[IO.File]::WriteAllBytes($installerExe, $out)
Sign-SundayFile $installerExe
Assert-SundayPublisher $installerExe

Remove-Item $payloadZip -Force
Remove-Item $staging -Recurse -Force

Write-Host ""
Write-Host "Installer: $installerExe ($((Get-Item $installerExe).Length / 1MB) MB, SUNDAY Launcher $version)"
Write-Host "Payload:   portable distribution + signed ledger-bound uninstaller"
