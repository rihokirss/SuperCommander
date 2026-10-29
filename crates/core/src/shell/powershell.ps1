Import-Module PSReadLine -ErrorAction Stop
if ($env:SUPERCOMMANDER_TERMINAL_HISTORY) {
    Set-PSReadLineOption -HistorySavePath $env:SUPERCOMMANDER_TERMINAL_HISTORY
}
Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+g' -ScriptBlock {
    $line = $null
    $cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    if ($line -notmatch '^SC__SC_MARKER__:[A-Za-z0-9+/]+={0,2}$') { return }
    try { $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(35))) }
    catch { return }
    [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
    try {
        Set-Location -LiteralPath $target -ErrorAction Stop
        [Console]::Write(([char]27).ToString() + ']633;SC:__SC_MARKER__:OK' + [char]7)
    } catch {
        Write-Error $_
        [Console]::Write(([char]27).ToString() + ']633;SC:__SC_MARKER__:FAIL' + [char]7)
    }
    [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()
}
$global:__sc_original_prompt = (Get-Item function:prompt).ScriptBlock
function global:prompt {
    $sc_result = & $global:__sc_original_prompt
    $sc_path = [string](Get-Location).ProviderPath
    $sc_encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sc_path))
    [Console]::Write(([char]27).ToString() + ']633;SC:__SC_MARKER__:' + $sc_encoded + [char]7)
    $sc_result
}
