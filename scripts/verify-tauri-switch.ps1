param(
    [Parameter(Mandatory)][string]$Package,
    [Parameter(Mandatory)][string]$PreviousExecutable,
    [Parameter(Mandatory)][string]$Output
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path -LiteralPath $Package).Path
$oldExe = (Resolve-Path -LiteralPath $PreviousExecutable).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('canvas-switch-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$oldProfile = Join-Path $root 'previous'
$profile = Join-Path $root 'candidate'
$backup = Join-Path $root 'backup'
$shortcutPath = Join-Path $root 'Canvas test.lnk'
$sample = Join-Path $oldProfile 'sample-project-v2'
$null = New-Item -ItemType Directory -Path $oldProfile, $sample
Copy-Item -LiteralPath (Join-Path $packageRoot 'sample\project.json') -Destination (Join-Path $sample 'project.json')
$binding = @{ root=$sample; manifest='project.json'; title='Synthetic migration binding' }
$tool = @{ python='C:\Windows\fixture-python.exe'; kdenlive=@{command='C:\Windows\fixture-tool.exe';args=@('fixture')} }
$settingsFile = Join-Path $oldProfile 'canvas-settings.json'
@{projects=@{'fixture'=$binding}; active='fixture'; review=@{project='fixture';view='s03'}; tools=$tool} |
    ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsFile -Encoding UTF8
$oldSettingsHash = (Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash
$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($shortcutPath)
$link.TargetPath = $oldExe
$link.Description = 'Synthetic test shortcut'
$link.Save()
$oldHash = (Get-FileHash -LiteralPath $shortcutPath -Algorithm SHA256).Hash
$key = 'Registry::HKEY_CURRENT_USER\Software\ProductionCanvasSwitchTest-' + [guid]::NewGuid().ToString('N')
$null = New-Item -Path $key
$oldCommand = '"' + $oldExe + '" "%1"'
$fixtureKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key.Substring('Registry::HKEY_CURRENT_USER\'.Length), $true)
try { $fixtureKey.SetValue('', $oldCommand, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $fixtureKey.Dispose() }
$entry = Join-Path $packageRoot 'scripts\switch-local-canvas.ps1'
$candidateExe = Join-Path $packageRoot 'desktop\production-canvas.exe'
$sha = (Get-FileHash -LiteralPath $candidateExe -Algorithm SHA256).Hash
$parameters = @{
    Candidate=$candidateExe
    Shortcut=$shortcutPath
    OpenCommandKey=$key
    PreviousProfile=$oldProfile
    ProfileDirectory=$profile
    BackupDirectory=$backup
}
try {
    $plan = & $entry @parameters
    if ($plan.projectCount -ne 1 -or (Test-Path -LiteralPath $profile)) { throw 'Planning changed state.' }
    $result = & $entry -Action Apply -ExpectedSha256 $sha @parameters
    if ($result.action -ne 'Applied') { throw 'Test migration was not applied.' }
    $updated = Get-Content -LiteralPath (Join-Path $profile 'canvas-settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($updated.tools.kdenlive.command -ne $tool.kdenlive.command -or $updated.active -ne 'fixture' -or
        $updated.projects.fixture.root -ne (Join-Path $profile 'sample-project-v2') -or
        $updated.review.view -ne 's03' -or $wsh.CreateShortcut($shortcutPath).TargetPath -ne $candidateExe -or
        (Get-Item -LiteralPath $key).GetValue('') -ne $plan.change.CandidateCommand) { throw 'The test migration did not preserve settings.' }
    $rollback = & $entry -Action Rollback -BackupDirectory $backup
    if ($rollback.action -ne 'RolledBack' -or (Get-FileHash -LiteralPath $shortcutPath -Algorithm SHA256).Hash -ne $oldHash -or
        (Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash -ne $oldSettingsHash -or
        (Get-Item -LiteralPath $key).GetValue('') -ne $oldCommand) { throw 'Rollback did not restore exact prior values.' }
    $evidence = @{planReadOnly=$true; migratedToolSettings=$true; remappedProfileSample=$true; exactShortcutRollback=$true; openCommandRollback=$true}
    $target = [IO.Path]::GetFullPath($Output)
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)
    $evidence | ConvertTo-Json | Set-Content -LiteralPath $target -Encoding UTF8
    $evidence | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $key
}
