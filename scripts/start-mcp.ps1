$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $pluginRoot 'runtime\python\python.exe'
$server = Join-Path $pluginRoot 'mcp\server.py'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'The bundled Python runtime is missing. Extract the complete plugin archive.'
}
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw 'The bundled MCP adapter is missing. Extract the complete plugin archive.'
}
& $python -I -B -X utf8 $server
exit $LASTEXITCODE
