#Requires -Version 5.1
<#
.SYNOPSIS
    Installs OneShot Remote SSH into VSCodium on Windows.

.DESCRIPTION
    1. Downloads the latest release VSIX (or uses -Vsix).
    2. Removes conflicting SSH extensions that claim the same "ssh-remote"
       connections (jeanp413.open-remote-ssh, ms-vscode-remote.remote-ssh),
       unless -KeepOthers is given.
    3. Adds the extension to "enable-proposed-api" in
       %USERPROFILE%\.vscode-oss\argv.json (required: it uses the proposed
       "resolvers" API).

    Close VSCodium before running; argv.json is read at startup.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Vsix .\oneshot-remote-ssh.vsix
#>
[CmdletBinding()]
param(
    [string]$Vsix,
    [switch]$KeepOthers
)

$ErrorActionPreference = 'Stop'

$ExtId     = 'guyliandejong.oneshot-remote-ssh'
$VsixUrl   = 'https://github.com/GuyliandeJong/oneshot-remote-ssh/releases/latest/download/oneshot-remote-ssh.vsix'
$Conflicts = @('jeanp413.open-remote-ssh', 'ms-vscode-remote.remote-ssh')
$Argv      = Join-Path $env:USERPROFILE '.vscode-oss\argv.json'

function Write-Step([string]$Msg) { Write-Host "==> $Msg" -ForegroundColor Cyan }

# Native commands write Node deprecation warnings to stderr; keep those from
# becoming terminating errors under ErrorActionPreference=Stop.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $all = & $Exe @Arguments 2>&1; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    [pscustomobject]@{
        ExitCode = $code
        Out = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    }
}

function Find-Codium {
    foreach ($c in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\VSCodium\bin\codium.cmd'),
        (Join-Path $env:ProgramFiles 'VSCodium\bin\codium.cmd'))) {
        if (Test-Path $c) { return $c }
    }
    $cmd = Get-Command codium.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'VSCodium (codium.cmd) not found.'
}

# Inserts the extension id into "enable-proposed-api" of a JSON-with-comments
# file, preserving comments. Skips strings and comments while scanning.
function Add-ProposedApi([string]$Path, [string]$Id) {
    $text = [IO.File]::ReadAllText($Path)
    $tokens = New-Object System.Collections.Generic.List[object]
    $i = 0; $n = $text.Length
    while ($i -lt $n) {
        $c = $text[$i]
        if ($c -eq '"') {
            $j = $i + 1
            while ($j -lt $n -and $text[$j] -ne '"') { if ($text[$j] -eq '\') { $j += 2 } else { $j++ } }
            $tokens.Add([pscustomobject]@{ Idx = $j; Ch = '"'; Tok = $text.Substring($i, $j - $i + 1) })
            $i = $j + 1; continue
        }
        if ($i + 1 -lt $n -and $text.Substring($i, 2) -eq '//') {
            $j = $text.IndexOf("`n", $i); if ($j -lt 0) { $i = $n } else { $i = $j }; continue
        }
        if ($i + 1 -lt $n -and $text.Substring($i, 2) -eq '/*') {
            $j = $text.IndexOf('*/', $i + 2); if ($j -lt 0) { $i = $n } else { $i = $j + 2 }; continue
        }
        if (-not [char]::IsWhiteSpace($c)) { $tokens.Add([pscustomobject]@{ Idx = $i; Ch = [string]$c; Tok = [string]$c }) }
        $i++
    }

    for ($k = 0; $k -lt $tokens.Count - 2; $k++) {
        if ($tokens[$k].Tok -eq '"enable-proposed-api"' -and $tokens[$k + 1].Ch -eq ':' -and $tokens[$k + 2].Ch -eq '[') {
            $open = $tokens[$k + 2].Idx
            $empty = ($k + 3 -lt $tokens.Count) -and $tokens[$k + 3].Ch -eq ']'
            $insert = $(if ($empty) { "`"$Id`"" } else { "`"$Id`", " })
            [IO.File]::WriteAllText($Path, $text.Insert($open + 1, $insert))
            return
        }
    }

    $depth = 0; $close = -1; $last = -1
    foreach ($t in $tokens) {
        if ('{', '[' -contains $t.Ch) { $depth++ }
        elseif ('}', ']' -contains $t.Ch) {
            $depth--
            if ($depth -eq 0 -and $t.Ch -eq '}') { $close = $t.Idx; break }
        }
        $last = $t.Idx
    }
    if ($close -lt 0) { throw "$Path`: no closing brace found" }
    $entry = "`r`n`t`"enable-proposed-api`": [`"$Id`"]`r`n"
    if ('{', ',' -contains [string]$text[$last]) {
        $new = $text.Substring(0, $close).TrimEnd() + $entry + $text.Substring($close)
    } else {
        $new = $text.Substring(0, $last + 1) + ',' + $text.Substring($last + 1, $close - $last - 1).TrimEnd() + $entry + $text.Substring($close)
    }
    [IO.File]::WriteAllText($Path, $new)
}

if (Get-Process -Name 'VSCodium' -ErrorAction SilentlyContinue) {
    throw 'Close all VSCodium windows first; argv.json is only read at startup.'
}

$codium = Find-Codium

$tmp = $null
if (-not $Vsix) {
    $tmp = Join-Path $env:TEMP ("oneshot-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $Vsix = Join-Path $tmp 'oneshot-remote-ssh.vsix'
    Write-Step 'Downloading latest release'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $VsixUrl -OutFile $Vsix -UseBasicParsing
}
if (-not (Test-Path $Vsix)) { throw "VSIX not found: $Vsix" }

try {
    Write-Step "Installing into $codium"
    if (-not $KeepOthers) {
        $installed = (Invoke-Native $codium @('--list-extensions')).Out
        foreach ($c in $Conflicts) {
            if ($installed -contains $c) {
                $r = Invoke-Native $codium @('--uninstall-extension', $c)
                if ($r.ExitCode -eq 0) { Write-Host "    removed conflicting $c" }
            }
        }
    }
    $r = Invoke-Native $codium @('--install-extension', (Resolve-Path $Vsix).Path, '--force')
    if ($r.ExitCode -ne 0) { throw "Install failed: $($r.Out -join ' ')" }
    Write-Host "    installed $ExtId"

    Write-Step "Enabling proposed API in $Argv"
    New-Item -ItemType Directory -Force -Path (Split-Path $Argv -Parent) | Out-Null
    if (-not (Test-Path $Argv) -or -not (Get-Content $Argv -Raw).Trim()) { Set-Content -Path $Argv -Value '{}' -Encoding UTF8 }
    if ((Get-Content $Argv -Raw) -match [regex]::Escape($ExtId)) {
        Write-Host '    already enabled'
    } else {
        Copy-Item $Argv "$Argv.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Add-ProposedApi $Argv $ExtId
        Write-Host "    added $ExtId"
    }
} finally {
    if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Step 'Done'
Write-Host "    Start VSCodium, then connect with 'OneShot SSH: Connect to Host...'."
Write-Host '    For one MFA prompt per connection set, per host:'
Write-Host '      "remote.SSH.remotePlatform": { "<host>": "linux" },'
Write-Host '      "remote.SSH.remoteArch":     { "<host>": "x86_64" }'
