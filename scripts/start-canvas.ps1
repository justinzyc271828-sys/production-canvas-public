param(
    [string]$ProfileDirectory
)

$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$application = Join-Path $pluginRoot 'desktop\production-canvas.exe'
if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
    throw 'The bundled desktop application is missing. Extract the complete plugin archive.'
}
$parameters = @{
    FilePath = $application
    WorkingDirectory = $pluginRoot
    WindowStyle = 'Hidden'
}
if ($ProfileDirectory) {
    if (-not [IO.Path]::IsPathRooted($ProfileDirectory) -or [IO.Path]::GetPathRoot($ProfileDirectory).Length -lt 3) {
        throw 'ProfileDirectory must be an absolute path.'
    }
    if ($ProfileDirectory.Contains('"')) {
        throw 'ProfileDirectory must not contain a quote character.'
    }
    $parameters.ArgumentList = '"--profile=' + $ProfileDirectory + '"'
}
Start-Process @parameters
