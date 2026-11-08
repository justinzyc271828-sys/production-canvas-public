param(
    [ValidateSet('Plan','Apply','Rollback')][string]$Action = 'Plan',
    [string]$Candidate = (Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop\production-canvas.exe'),
    [string]$ExpectedSha256,
    [string]$Shortcut,
    [string]$OpenCommandKey,
    [string]$PreviousProfile = (Join-Path $env:APPDATA 'Production Canvas'),
    [string]$ProfileDirectory = (Join-Path $env:LOCALAPPDATA 'ProductionCanvasTauri'),
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$encoding = [Text.UTF8Encoding]::new($false)
$wsh = New-Object -ComObject WScript.Shell

function Save-Json($Path, $Value) {
    $temporary = $Path + '.pending'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine, $encoding)
    [IO.File]::Move($temporary, $Path)
}

function Read-Json($Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Set-OpenCommand($Path, $Value) {
    $prefix = 'Registry::HKEY_CURRENT_USER\'
    if (-not $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Expected a writable HKEY_CURRENT_USER Canvas command.'
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Path.Substring($prefix.Length), $true)
    if (-not $key) { throw 'The Canvas Open with key is unavailable.' }
    try { $key.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
}

function Restore-Entries($Journal, $BackupShortcut) {
    if ((Get-FileHash -LiteralPath $BackupShortcut -Algorithm SHA256).Hash -ne $Journal.ShortcutSha256) {
        throw 'The rollback shortcut does not match its recorded hash.'
    }
    $shortcut = $wsh.CreateShortcut($Journal.Shortcut)
    if ($shortcut.TargetPath -eq $Journal.Candidate) {
        if ($shortcut.Arguments -ne $Journal.CandidateArguments) { throw 'The candidate shortcut arguments changed.' }
        $receipt = Join-Path (Split-Path -Parent $BackupShortcut) 'candidate-shortcut.sha256'
        if ((Test-Path -LiteralPath $receipt -PathType Leaf) -and
            (Get-FileHash -LiteralPath $Journal.Shortcut -Algorithm SHA256).Hash -ne (Get-Content -LiteralPath $receipt -Raw).Trim()) {
            throw 'The desktop shortcut changed after this migration.'
        }
    } elseif ((Get-FileHash -LiteralPath $Journal.Shortcut -Algorithm SHA256).Hash -ne $Journal.ShortcutSha256) {
        throw 'The desktop shortcut changed after this migration.'
    }
    $current = (Get-Item -LiteralPath $Journal.OpenCommandKey).GetValue('')
    if ($current -ne $Journal.CandidateCommand -and $current -ne $Journal.PreviousCommand) {
        throw 'The Open with command changed after this migration.'
    }
    Set-OpenCommand $Journal.OpenCommandKey $Journal.PreviousCommand
    Copy-Item -LiteralPath $BackupShortcut -Destination $Journal.Shortcut -Force
}

if ($Action -eq 'Rollback') {
    if (-not $BackupDirectory) { throw 'Provide the recorded backup directory.' }
    $backup = (Resolve-Path -LiteralPath $BackupDirectory).Path
    $journal = Read-Json (Join-Path $backup 'switch.json')
    Restore-Entries $journal (Join-Path $backup 'previous.lnk')
    [pscustomobject]@{action='RolledBack'; shortcut=$journal.Shortcut; restoredExecutable=$journal.PreviousExecutable}
    return
}

if (-not $Shortcut -or -not $OpenCommandKey) { throw 'Specify the existing Canvas shortcut and Canvas Open with command key.' }
$exe = (Resolve-Path -LiteralPath $Candidate).Path
$lnk = (Resolve-Path -LiteralPath $Shortcut).Path
$oldProfile = (Resolve-Path -LiteralPath $PreviousProfile).Path
$newProfile = [IO.Path]::GetFullPath($ProfileDirectory)
if ($lnk -notlike '*.lnk' -or $newProfile -eq $oldProfile -or $newProfile.Contains('"')) {
    throw 'Expected an existing .lnk and a separate profile directory.'
}
$sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$oldShortcut = $wsh.CreateShortcut($lnk)
$oldExe = (Resolve-Path -LiteralPath $oldShortcut.TargetPath).Path
$oldCommand = (Get-Item -LiteralPath $OpenCommandKey).GetValue('')
if ($oldCommand -ne ('"' + $oldExe + '" "%1"')) {
    throw 'The specified Open with command does not match the current Canvas shortcut.'
}
$settings = Read-Json (Join-Path $oldProfile 'canvas-settings.json')
if (-not $settings.projects -or -not $settings.active) { throw 'The previous profile settings are incomplete.' }
$candidateArgs = '"--profile=' + $newProfile + '" --language=zh-CN'
$newCommand = '"' + $exe + '" ' + $candidateArgs + ' "%1"'
$journal = [ordered]@{
    Candidate = $exe
    CandidateSha256 = $sha
    CandidateCommand = $newCommand
    CandidateArguments = $candidateArgs
    PreviousExecutable = $oldExe
    PreviousCommand = $oldCommand
    Shortcut = $lnk
    ShortcutSha256 = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
    OpenCommandKey = $OpenCommandKey
    NewProfile = $newProfile
    PreviousProfile = $oldProfile
}
if ($Action -eq 'Plan') {
    [pscustomobject]@{action='Plan'; projectCount=@($settings.projects.PSObject.Properties).Count; change=$journal}
    return
}
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $ExpectedSha256 -ne $sha) {
    throw 'The reviewed candidate executable SHA-256 is required.'
}
if (-not $BackupDirectory -or (Test-Path -LiteralPath $BackupDirectory) -or (Test-Path -LiteralPath $newProfile)) {
    throw 'Use new backup and candidate profile directories to preserve existing records.'
}
$backup = [IO.Path]::GetFullPath($BackupDirectory)
$null = New-Item -ItemType Directory -Path $backup, $newProfile
$savedShortcut = Join-Path $backup 'previous.lnk'
Copy-Item -LiteralPath $lnk -Destination $savedShortcut
Save-Json (Join-Path $backup 'switch.json') $journal
foreach ($name in @('sample-project-v2','sample-project-illustrated')) {
    $oldSample = Join-Path $oldProfile $name
    if (Test-Path -LiteralPath $oldSample -PathType Container) {
        $newSample = Join-Path $newProfile $name
        Copy-Item -LiteralPath $oldSample -Destination $newSample -Recurse
        foreach ($entry in $settings.projects.PSObject.Properties) {
            if ($entry.Value.root -eq $oldSample) { $entry.Value.root = $newSample }
        }
    }
}
Save-Json (Join-Path $newProfile 'canvas-settings.json') $settings
try {
    $link = $wsh.CreateShortcut($lnk)
    $link.TargetPath = $exe
    $link.Arguments = $candidateArgs
    $link.WorkingDirectory = Split-Path -Parent $exe
    $link.IconLocation = $exe + ',0'
    $link.Save()
    [IO.File]::WriteAllText((Join-Path $backup 'candidate-shortcut.sha256'), (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash, $encoding)
    Set-OpenCommand $OpenCommandKey $newCommand
    if ($wsh.CreateShortcut($lnk).TargetPath -ne $exe -or (Get-Item -LiteralPath $OpenCommandKey).GetValue('') -ne $newCommand) {
        throw 'Could not verify the new Windows entry points.'
    }
} catch {
    Restore-Entries $journal $savedShortcut
    throw
}
[pscustomobject]@{action='Applied'; backup=$backup; profile=$newProfile; candidateSha256=$sha}
