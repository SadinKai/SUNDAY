$ErrorActionPreference = 'Stop'
$utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
Import-Module $utilityModule -Force -ErrorAction Stop

$root = Split-Path -Parent $PSScriptRoot
$portableSource = Join-Path $root 'dist\Sunday'
$sourceSundayExe = Join-Path $portableSource 'Sunday.exe'
$sourceNodeExe = Join-Path $portableSource 'node.exe'
$reportPath = Join-Path $root 'dist\single-instance-test.json'
foreach ($required in @($sourceSundayExe, $sourceNodeExe)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "SUNDAY Launcher release binary is missing: $required" }
}

$existing = @(Get-CimInstance Win32_Process -Filter "Name = 'Sunday.exe'" -ErrorAction Stop)
if ($existing.Count -ne 0) {
  throw 'Single-instance qualification requires no pre-existing SUNDAY Launcher process; none will be terminated by this test.'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('sunday-single-owner-' + [Guid]::NewGuid().ToString('N'))
$savedEnvironment = @{}
$environmentNames = @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')
$first = $null
$second = $null
$ownedNodeChildren = @()
$sundayExe = $null
$nodeExe = $null

function Stop-QualifiedProcess($Process, [string]$ExpectedPath) {
  if ($null -eq $Process) { return }
  try { $Process.Refresh() } catch { return }
  if ($Process.HasExited) { return }
  $actualPath = $Process.MainModule.FileName
  if ([IO.Path]::GetFullPath($actualPath) -cne [IO.Path]::GetFullPath($ExpectedPath)) {
    throw "Refusing to stop a process whose executable identity changed: $actualPath"
  }
  Stop-Process -InputObject $Process -Force -ErrorAction Stop
  if (-not $Process.WaitForExit(10000)) { throw "Owned process did not stop: $actualPath" }
}

try {
  foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  $testApp = Join-Path $testRoot 'app'
  $local = Join-Path $testRoot 'local'
  $roaming = Join-Path $testRoot 'roaming'
  $temp = Join-Path $testRoot 'temp'
  foreach ($directory in @($testApp, $local, $roaming, $temp)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  Get-ChildItem -LiteralPath $portableSource -Force |
    Where-Object { $_.Name -cne 'Sunday.exe.WebView2' } |
    Copy-Item -Destination $testApp -Recurse -Force
  $sundayExe = Join-Path $testApp 'Sunday.exe'
  $nodeExe = Join-Path $testApp 'node.exe'
  $env:LOCALAPPDATA = $local
  $env:APPDATA = $roaming
  $env:TEMP = $temp
  $env:TMP = $temp

  $firstStdout = Join-Path $testRoot 'owner.stdout.log'
  $firstStderr = Join-Path $testRoot 'owner.stderr.log'
  $secondStdout = Join-Path $testRoot 'second.stdout.log'
  $secondStderr = Join-Path $testRoot 'second.stderr.log'
  $first = Start-Process -FilePath $sundayExe -WorkingDirectory (Split-Path -Parent $sundayExe) `
    -RedirectStandardOutput $firstStdout -RedirectStandardError $firstStderr -PassThru
  Start-Sleep -Seconds 4
  $first.Refresh()
  if ($first.HasExited) {
    $first.WaitForExit()
    $stderrText = if (Test-Path -LiteralPath $firstStderr) { (Get-Content -Raw -LiteralPath $firstStderr).Trim() } else { '' }
    throw "The owner SUNDAY Launcher process exited during startup with code $($first.ExitCode). stderr: $stderrText"
  }
  if ([IO.Path]::GetFullPath($first.MainModule.FileName) -cne [IO.Path]::GetFullPath($sundayExe)) {
    throw 'The first process executable identity does not match the qualified SUNDAY Launcher artifact.'
  }

  $firstStart = $first.StartTime.ToUniversalTime().ToString('o')
  $firstPid = $first.Id
  $second = Start-Process -FilePath $sundayExe -WorkingDirectory (Split-Path -Parent $sundayExe) `
    -ArgumentList '--single-instance-probe' -RedirectStandardOutput $secondStdout -RedirectStandardError $secondStderr -PassThru
  $secondExited = $second.WaitForExit(15000)
  if ($secondExited) { $second.WaitForExit(); $second.Refresh() }
  $first.Refresh()
  if (-not $secondExited) { throw 'The second SUNDAY Launcher invocation did not exit after forwarding intent.' }
  if ($first.HasExited) { throw 'The owner SUNDAY Launcher process exited when the second invocation started.' }

  Start-Sleep -Seconds 2
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $firstPid" -ErrorAction Stop)
  foreach ($child in $children) {
    if ($child.ExecutablePath -and [IO.Path]::GetFullPath($child.ExecutablePath) -ceq [IO.Path]::GetFullPath($nodeExe)) {
      $ownedNodeChildren += Get-Process -Id $child.ProcessId -ErrorAction Stop
    }
  }
  if ($ownedNodeChildren.Count -ne 1) {
    throw "Expected exactly one owner backend node process; observed $($ownedNodeChildren.Count)."
  }

  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    launcherSha256 = (Get-FileHash -LiteralPath $sourceSundayExe -Algorithm SHA256).Hash.ToLowerInvariant()
    isolatedAppData = $true
    isolatedPortableCopy = $true
    owner = [ordered]@{
      pid = $firstPid
      creationTimeUtc = $firstStart
      remainedRunning = $true
      backendNodeCount = $ownedNodeChildren.Count
    }
    secondInvocation = [ordered]@{
      pid = $second.Id
      exitedAfterIntentForward = $secondExited
    }
    roblox = [ordered]@{
      launchAttempted = $false
      processActionAttempted = $false
      qualification = 'NOT RUN'
    }
  }
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Write-Host "Single-instance qualification passed: $reportPath"
  Write-Host "Owner PID $firstPid remained active; second PID $($second.Id) exited after forwarding; one backend owner observed."
} finally {
  if ($first -and -not $first.HasExited) {
    $null = $first.CloseMainWindow()
    $null = $first.WaitForExit(10000)
  }
  if ($nodeExe) { foreach ($child in $ownedNodeChildren) { Stop-QualifiedProcess $child $nodeExe } }
  if ($sundayExe) { Stop-QualifiedProcess $first $sundayExe }
  foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $resolved).StartsWith('sunday-single-owner-')) {
      throw "Refusing to remove unexpected single-instance test directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
