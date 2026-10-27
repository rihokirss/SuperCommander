# CI provisions its own runtime; never install software on a user's desktop here.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Run only on a dedicated CI runner' }

# https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
function Get-WebViewVersion {
    foreach ($key in @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )) {
        $value = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue).pv
        if ($value -and [version]$value -gt [version]'0.0.0.0') { return $value }
    }
}

$runtimeVersion = Get-WebViewVersion
if (-not $runtimeVersion) {
    $installer = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebview2Setup.exe'
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
    $process = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -Wait -PassThru
    $runtimeVersion = Get-WebViewVersion
    if (-not $runtimeVersion) { throw "WebView2 runtime installation failed (exit $($process.ExitCode))" }
}
Write-Host "WebView2 runtime: $runtimeVersion"
