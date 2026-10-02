$ErrorActionPreference = 'Stop'

$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $securityModule -Force -ErrorAction Stop
$utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
Import-Module $utilityModule -Force -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$portable = Join-Path $dist 'Sunday'
$installer = Join-Path $dist 'SundayInstaller.exe'
$uninstaller = Join-Path $dist 'SundayUninstall.exe'
$portableZipItem = Get-ChildItem -LiteralPath $dist -Filter 'SundayPortable_*_x64.zip' -File |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $portableZipItem) {
  throw 'Required portable archive is missing. Run npm run release:package after npm run dist.'
}
$portableZip = $portableZipItem.FullName

foreach ($required in @($installer, $uninstaller, $portableZip, (Join-Path $portable 'Sunday.exe'), (Join-Path $portable 'node.exe'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required release artifact is missing: $required"
  }
}

function Read-U16([byte[]]$Bytes, [int]$Offset) {
  if ($Offset -lt 0 -or $Offset + 2 -gt $Bytes.Length) { throw 'PE field is out of range.' }
  [BitConverter]::ToUInt16($Bytes, $Offset)
}

function Read-U32([byte[]]$Bytes, [int]$Offset) {
  if ($Offset -lt 0 -or $Offset + 4 -gt $Bytes.Length) { throw 'PE field is out of range.' }
  [BitConverter]::ToUInt32($Bytes, $Offset)
}

function Get-PeInfo([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Not a DOS/PE image: $Path"
  }
  $pe = [int](Read-U32 $bytes 0x3c)
  if ($pe + 24 -gt $bytes.Length -or [Text.Encoding]::ASCII.GetString($bytes, $pe, 4) -ne "PE`0`0") {
    throw "Invalid PE signature: $Path"
  }
  $machine = Read-U16 $bytes ($pe + 4)
  $optional = $pe + 24
  $magic = Read-U16 $bytes $optional
  $securityDirectory = if ($magic -eq 0x20b) { $optional + 144 } elseif ($magic -eq 0x10b) { $optional + 128 } else { throw "Unknown PE optional-header magic in $Path" }
  $certificateOffset = [uint64](Read-U32 $bytes $securityDirectory)
  $certificateSize = [uint64](Read-U32 $bytes ($securityDirectory + 4))
  $certificateEnd = $certificateOffset + $certificateSize
  $payloadBoundary = [uint64]$bytes.Length
  if ($certificateOffset -ge 16 -and $certificateSize -ge 8 -and $certificateEnd -le [uint64]$bytes.Length) {
    $payloadBoundary = $certificateOffset
  }
  $timestamp = [DateTimeOffset]::FromUnixTimeSeconds([int64](Read-U32 $bytes ($pe + 8))).UtcDateTime.ToString('o')
  $version = (Get-Item -LiteralPath $Path).VersionInfo
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  [ordered]@{
    path = $Path.Substring($root.Length + 1).Replace('\', '/')
    size = $bytes.LongLength
    sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    machine = ('0x{0:x4}' -f $machine)
    architecture = if ($machine -eq 0x8664) { 'x64' } else { 'unexpected' }
    optionalHeader = if ($magic -eq 0x20b) { 'PE32+' } else { 'PE32' }
    coffTimestampUtc = $timestamp
    productName = $version.ProductName
    companyName = $version.CompanyName
    fileDescription = $version.FileDescription
    productVersion = $version.ProductVersion
    fileVersion = $version.FileVersion
    originalFilename = $version.OriginalFilename
    authenticodeStatus = [string]$signature.Status
    signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    certificateOffset = $certificateOffset
    certificateSize = $certificateSize
    payloadBoundary = $payloadBoundary
  }
}

function Get-HookScan([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $ascii = [Text.Encoding]::ASCII.GetString($bytes)
  $utf16 = [Text.Encoding]::Unicode.GetString($bytes)
  $needles = @('SUNDAY_SETUP_LOG', '--demo', 'SUNDAY_UI_TEST_BROWSER_ARGS', 'SUNDAY_UI_TEST_DATA_DIRECTORY')
  $found = @()
  foreach ($needle in $needles) {
    if ($ascii.Contains($needle) -or $utf16.Contains($needle)) {
      $found += $needle
    }
  }
  [ordered]@{
    path = $Path.Substring($root.Length + 1).Replace('\', '/')
    forbiddenHooksFound = @($found)
  }
}

function Get-ProcessPrimitiveScan([string[]]$Paths, [string]$Scope) {
  $primitiveNames = @(
    'CreateMutexW', 'OpenProcess', 'TerminateProcess', 'DuplicateHandle',
    'VirtualAllocEx', 'WriteProcessMemory', 'NtQuerySystemInformation'
  )
  $found = @()
  $authoredForbiddenBindings = @()
  $legacyCompatibilityBindings = @()
  foreach ($path in $Paths) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $texts = @([Text.Encoding]::ASCII.GetString($bytes), [Text.Encoding]::Unicode.GetString($bytes))
    $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
    foreach ($name in $primitiveNames) {
      if ($texts[0].Contains($name) -or $texts[1].Contains($name)) {
        $found += $name
      }
    }
    if ($extension -in @('.js', '.mjs', '.cjs')) {
      $source = [IO.File]::ReadAllText($path)
      foreach ($name in @('DuplicateHandle', 'VirtualAllocEx', 'WriteProcessMemory', 'NtQuerySystemInformation')) {
        $bindingPattern = "[.]func\('[^']*\b$([regex]::Escape($name))\b"
        if ($source -match $bindingPattern) {
          $legacyBoundary = Join-Path $portable 'src\main\legacy-roblox-native.js'
          if ($path -ceq $legacyBoundary) {
            $legacyCompatibilityBindings += $name
          } else {
            $authoredForbiddenBindings += $name
          }
        }
      }
    }
  }
  [ordered]@{
    scope = $Scope
    primitiveNamesPresent = @($found | Sort-Object -Unique)
    authoredForbiddenBindingsFound = @($authoredForbiddenBindings | Sort-Object -Unique)
    legacyCompatibilityBindingsFound = @($legacyCompatibilityBindings | Sort-Object -Unique)
  }
}

function Get-NetworkOriginScan([string[]]$Paths) {
  $secure = @()
  $insecure = @()
  foreach ($path in $Paths) {
    $text = [IO.File]::ReadAllText($path)
    foreach ($match in [regex]::Matches($text, 'https://[A-Za-z0-9.-]+(?::[0-9]+)?')) {
      $secure += $match.Value.ToLowerInvariant()
    }
    foreach ($match in [regex]::Matches($text, 'http://[A-Za-z0-9.-]+(?::[0-9]+)?')) {
      $insecure += $match.Value.ToLowerInvariant()
    }
  }
  [ordered]@{
    scope = 'dist/Sunday/src authored runtime files'
    httpsOrigins = @($secure | Sort-Object -Unique)
    insecureHttpOrigins = @($insecure | Sort-Object -Unique)
  }
}

function Expand-CheckedZip([string]$ZipPath, [string]$Destination) {
  $rootPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    if ($archive.Entries.Count -gt 20000) { throw 'Archive entry count exceeds the audit bound.' }
    $names = @{}
    [uint64]$total = 0
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.StartsWith('//') -or
          $name -match '^[A-Za-z]:' -or $name.Contains(':') -or $name -match '(^|/)\.\.(/|$)') {
        throw "Unsafe ZIP entry in artifact: $name"
      }
      $key = $name.TrimEnd('/').ToLowerInvariant()
      if ($names.ContainsKey($key)) { throw "Duplicate case-insensitive ZIP entry: $name" }
      $names[$key] = $true
      $total += [uint64]$entry.Length
      if ($entry.Length -gt 536870912 -or $total -gt 2147483648) { throw "ZIP expansion bound exceeded by $name" }
      if ($entry.CompressedLength -gt 0 -and [uint64]$entry.Length -gt [uint64]$entry.CompressedLength * 250) {
        throw "ZIP compression ratio bound exceeded by $name"
      }
      $target = [IO.Path]::GetFullPath((Join-Path $Destination $name.Replace('/', '\')))
      if (-not $target.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "ZIP entry escaped the audit directory: $name"
      }
      if ($name.EndsWith('/')) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
      } else {
        $parent = Split-Path -Parent $target
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $input = $entry.Open()
        $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-RelativeFileMap([string]$Directory) {
  $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  $map = [ordered]@{}
  foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File | Sort-Object FullName) {
    $full = [IO.Path]::GetFullPath($file.FullName)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "File escaped audit root: $full" }
    $relative = $full.Substring($prefix.Length).Replace('\', '/')
    $map[$relative] = [ordered]@{
      size = $file.Length
      sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $map
}

$auditRoot = Join-Path ([IO.Path]::GetTempPath()) ('sunday-artifact-audit-' + [Guid]::NewGuid().ToString('N'))
$payloadZip = Join-Path $auditRoot 'payload.zip'
$payloadDirectory = Join-Path $auditRoot 'payload'
$portableDirectory = Join-Path $auditRoot 'portable'

try {
  New-Item -ItemType Directory -Path $auditRoot | Out-Null
  $allowedPortableTopLevel = @('Sunday.exe', 'node.exe', 'src', 'node_modules')
  $unexpectedPortableItems = @(Get-ChildItem -LiteralPath $portable -Force |
    Where-Object { $allowedPortableTopLevel -notcontains $_.Name })
  if ($unexpectedPortableItems.Count -ne 0) {
    $names = ($unexpectedPortableItems | ForEach-Object Name) -join ', '
    throw "Portable tree contains runtime or unknown top-level content: $names"
  }
  $portableReparsePoints = @(Get-ChildItem -LiteralPath $portable -Recurse -Force |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
  if ($portableReparsePoints.Count -ne 0) {
    throw "Portable tree contains a reparse point: $($portableReparsePoints[0].FullName)"
  }
  $installerInfo = Get-PeInfo $installer
  $installerBytes = [IO.File]::ReadAllBytes($installer)
  $payloadEnd = [int64]$installerInfo.payloadBoundary
  if ($payloadEnd -lt 16) { throw 'Installer payload boundary is too small.' }
  $trailer = $payloadEnd - 16
  if ([Text.Encoding]::ASCII.GetString($installerBytes, [int]$trailer, 8) -ne 'SUNDAYST') {
    throw 'Installer payload trailer is absent at the authenticated boundary.'
  }
  $payloadStart = [BitConverter]::ToInt64($installerBytes, [int]$trailer + 8)
  if ($payloadStart -le 0 -or $payloadStart -ge $trailer) { throw 'Installer payload offset is invalid.' }
  $payloadLength = $trailer - $payloadStart
  if ($payloadLength -gt 536870912) { throw 'Installer payload exceeds the audit bound.' }
  $stream = [IO.File]::Open($payloadZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($installerBytes, [int]$payloadStart, [int]$payloadLength) } finally { $stream.Dispose() }

  Expand-CheckedZip $payloadZip $payloadDirectory
  Expand-CheckedZip $portableZip $portableDirectory

  $payloadMap = Get-RelativeFileMap $payloadDirectory
  $portableMap = Get-RelativeFileMap $portable
  $zipMap = Get-RelativeFileMap $portableDirectory
  $manifestPath = Join-Path $payloadDirectory 'sunday-install-manifest.json'
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.product -cne 'SUNDAY Launcher') { throw 'Embedded install manifest identity is invalid.' }
  $declared = @{}
  foreach ($file in $manifest.files) {
    $key = ([string]$file.path).Replace('\', '/')
    if ($declared.ContainsKey($key.ToLowerInvariant())) { throw "Duplicate manifest path: $key" }
    $declared[$key.ToLowerInvariant()] = $true
    if (-not $payloadMap.Contains($key)) { throw "Manifest file is missing from payload: $key" }
    $actual = $payloadMap[$key]
    if ([uint64]$file.size -ne [uint64]$actual.size -or ([string]$file.sha256).ToLowerInvariant() -cne $actual.sha256) {
      throw "Manifest size/hash mismatch: $key"
    }
  }
  $payloadDataFiles = @($payloadMap.Keys | Where-Object { $_ -cne 'sunday-install-manifest.json' })
  if ($payloadDataFiles.Count -ne $manifest.files.Count) { throw 'Payload and install manifest file counts differ.' }
  foreach ($key in $payloadDataFiles) {
    if (-not $declared.ContainsKey($key.ToLowerInvariant())) { throw "Undeclared payload file: $key" }
  }
  if ($portableMap.Count -ne $zipMap.Count) { throw 'Portable ZIP and dist/Sunday file counts differ.' }
  foreach ($key in $portableMap.Keys) {
    if (-not $zipMap.Contains($key) -or $portableMap[$key].sha256 -cne $zipMap[$key].sha256) {
      throw "Portable ZIP content differs from dist/Sunday: $key"
    }
  }

  $embeddedEquality = [ordered]@{
    launcher = $payloadMap['Sunday.exe'].sha256 -ceq $portableMap['Sunday.exe'].sha256
    node = $payloadMap['node.exe'].sha256 -ceq $portableMap['node.exe'].sha256
    uninstaller = $payloadMap['uninstall.exe'].sha256 -ceq (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if ($embeddedEquality.Values -contains $false) { throw 'An embedded executable differs from its release-tree source.' }

  $launcherExe = Join-Path $portable 'Sunday.exe'
  $nodeExe = Join-Path $portable 'node.exe'
  $peFiles = @($installer, $uninstaller, $launcherExe, $nodeExe)
  $productPeFiles = @($installer, $uninstaller, $launcherExe)
  $peInfo = @($peFiles | ForEach-Object { Get-PeInfo $_ })
  foreach ($info in @($peInfo | Where-Object { $_.path -cne 'dist/Sunday/node.exe' })) {
    if ($info.productName -cne 'SUNDAY Launcher' -or $info.productVersion -cne $manifest.version -or
        $info.fileVersion -cne $manifest.version -or $info.companyName -cne 'SADINKAI') {
      throw "SUNDAY Launcher executable VERSIONINFO identity is inconsistent: $($info.path)"
    }
  }
  foreach ($info in @($peInfo | Where-Object { $_.path -in @('dist/SundayInstaller.exe', 'dist/SundayUninstall.exe') })) {
    if ($info.fileDescription -cne 'SUNDAY Launcher Installer') {
      throw "Installer executable description is inconsistent: $($info.path)"
    }
  }
  $authoredFiles = @(Get-ChildItem -LiteralPath (Join-Path $portable 'src') -Recurse -File |
    Where-Object { $_.Extension -in @('.js', '.mjs', '.cjs', '.html', '.json') } |
    ForEach-Object FullName)
  $binaryPrimitiveScan = Get-ProcessPrimitiveScan $productPeFiles 'SUNDAY Launcher PE files'
  $sourcePrimitiveScan = Get-ProcessPrimitiveScan $authoredFiles 'dist/Sunday/src authored runtime files'
  if ($sourcePrimitiveScan.authoredForbiddenBindingsFound.Count -ne 0) {
    throw 'A foreign-process mutation binding exists outside the explicit legacy compatibility island.'
  }
  $networkOriginScan = Get-NetworkOriginScan $authoredFiles
  if ($networkOriginScan.insecureHttpOrigins.Count -ne 0) {
    throw 'An insecure HTTP origin is present in authored release runtime files.'
  }
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    product = 'SUNDAY Launcher'
    version = $manifest.version
    peFiles = $peInfo
    installerPayload = [ordered]@{
      authenticatedBoundary = $payloadEnd
      payloadStart = $payloadStart
      payloadLength = $payloadLength
      manifestFileCount = $manifest.files.Count
      extractedFileCount = $payloadMap.Count
      closedWorldManifest = $true
      embeddedEquality = $embeddedEquality
    }
    portableZip = [ordered]@{
      path = $portableZip.Substring($root.Length + 1).Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath $portableZip -Algorithm SHA256).Hash.ToLowerInvariant()
      exactContentEquality = $true
      fileCount = $zipMap.Count
    }
    releaseHookScan = @($peFiles | Where-Object { $_ -notlike '*node.exe' } | ForEach-Object { Get-HookScan $_ })
    processPrimitiveScan = @($binaryPrimitiveScan, $sourcePrimitiveScan)
    networkOriginScan = $networkOriginScan
    limitations = @(
      'The Windows binaries are intentionally unsigned; this audit records integrity and signature status but does not establish publisher identity.',
      'This audit does not install or execute the installer; real-Windows packaged-build qualification is recorded separately.',
      'PE primitive-name presence records linked Windows or Rust runtime symbols and does not by itself prove an authored reachable operation; authored JavaScript bindings are checked separately.',
      'Published-digest verification requires downloading the final GitHub release assets and comparing their SHA-256 values.'
    )
  }
  $outputPath = Join-Path $dist 'artifact-audit.json'
  [IO.File]::WriteAllText($outputPath, ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  Write-Host "Artifact audit passed: $outputPath"
  Write-Host "PEs: $($peFiles.Count); payload files: $($payloadMap.Count); portable files: $($zipMap.Count)"
} finally {
  if (Test-Path -LiteralPath $auditRoot) {
    $resolved = [IO.Path]::GetFullPath($auditRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $resolved).StartsWith('sunday-artifact-audit-')) {
      throw "Refusing to remove unexpected audit directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
