param(
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$NodeDirectory,
    [Parameter(Mandatory)][string]$PythonDirectory,
    [switch]$Offline,
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destination) { throw "Choose a new package directory: $destination" }
$node = (Resolve-Path -LiteralPath $NodeDirectory).Path
$python = (Resolve-Path -LiteralPath $PythonDirectory).Path
foreach ($file in @((Join-Path $node 'node.exe'),(Join-Path $node 'LICENSE'),(Join-Path $python 'python.exe'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Incomplete runtime: $file" }
}
$commit = git -C $root rev-parse HEAD
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Draft) { $commit += '+draft' }
elseif (git -C $root --no-optional-locks status --porcelain) { throw 'Commit the reviewed source before packaging.' }

$rustup = Join-Path $env:USERPROFILE 'scoop\apps\rustup\current'
if (-not $env:RUSTUP_HOME -and (Test-Path -LiteralPath (Join-Path $rustup '.rustup\toolchains'))) {
    $env:RUSTUP_HOME = Join-Path $rustup '.rustup'
}
if (-not $env:CARGO_HOME -and (Test-Path -LiteralPath (Join-Path $rustup '.cargo\registry'))) {
    $env:CARGO_HOME = Join-Path $rustup '.cargo'
}
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target' }
$manifest = Join-Path $root 'src-tauri\Cargo.toml'
$argsForCargo = @('--locked', '--manifest-path', $manifest)
if ($Offline) { $argsForCargo += '--offline' }
& cargo +stable build --release @argsForCargo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$metadata = & cargo +stable metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc @argsForCargo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$metadataFile = Join-Path $env:CARGO_TARGET_DIR 'production-canvas-cargo-metadata.json'
[IO.File]::WriteAllText($metadataFile, ($metadata -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
& (Join-Path $node 'node.exe') (Join-Path $PSScriptRoot 'stage-tauri.cjs') $destination (Join-Path $env:CARGO_TARGET_DIR 'release\production-canvas.exe') $node $python $commit $metadataFile
exit $LASTEXITCODE
