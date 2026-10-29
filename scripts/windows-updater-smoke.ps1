$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("sc updater ' " + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $source = Get-Content -Raw (Join-Path $PSScriptRoot '..\src-tauri\src\updates.rs')
  $match = [regex]::Match($source, 'const PORTABLE_HELPER: &str = r#"([\s\S]*?)"#;')
  if (-not $match.Success) { throw 'Portable helper not found' }
  $helper = Join-Path $root 'helper.ps1'
  [IO.File]::WriteAllText($helper, $match.Groups[1].Value)
  $target = Join-Path $root 'portable app.exe'
  $stage = Join-Path $root 'staged update.exe'
  $env:SC_UPDATE_TARGET = $target
  $env:SC_UPDATE_STAGE = $stage
  $env:SC_UPDATE_ERROR = Join-Path $root 'update-error.txt'

  # The helper must wait for the application to close before replacing it.
  [IO.File]::WriteAllText($target, 'old')
  [IO.File]::WriteAllText($stage, 'new')
  $env:SC_UPDATE_HASH = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
  $parent = Start-Process powershell.exe -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 8' -PassThru -WindowStyle Hidden
  $env:SC_UPDATE_PID = [string]$parent.Id
  $child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ([IO.File]::ReadAllText($target) -ne 'old') { throw 'Updated before the application closed' }
  $child.WaitForExit(30000) | Out-Null
  if (-not $child.HasExited -or [IO.File]::ReadAllText($target) -ne 'new') { throw 'Portable replacement failed' }

  # A modified staging file must never replace the original.
  [IO.File]::WriteAllText($target, 'original')
  [IO.File]::WriteAllText($stage, 'tampered')
  $env:SC_UPDATE_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
  $env:SC_UPDATE_PID = '0'
  $child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"" -PassThru -WindowStyle Hidden
  $child.WaitForExit(30000) | Out-Null
  if (-not $child.HasExited -or [IO.File]::ReadAllText($target) -ne 'original' -or (Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $env:SC_UPDATE_ERROR)) { throw 'Tampered update was not rejected safely' }

  # A locked destination must remain intact and report the failure.
  Remove-Item -LiteralPath $env:SC_UPDATE_ERROR
  [IO.File]::WriteAllText($stage, 'new')
  $env:SC_UPDATE_HASH = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
  $locked = [IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
  try {
    $child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"" -PassThru -WindowStyle Hidden
    $child.WaitForExit(30000) | Out-Null
    if (-not $child.HasExited) { throw 'Locked replacement did not finish' }
  } finally { $locked.Dispose() }
  if ([IO.File]::ReadAllText($target) -ne 'original' -or (Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $env:SC_UPDATE_ERROR)) { throw 'Locked destination was not handled safely' }
  Write-Host 'Portable update helper: wait, replace, tamper and locked-file checks passed.'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
