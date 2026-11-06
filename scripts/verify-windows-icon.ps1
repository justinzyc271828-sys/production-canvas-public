param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$ExpectedIcon
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Executable).Path)
$actual = $actualIcon.ToBitmap()
$expectedIconObject = [System.Drawing.Icon]::new(
  (Resolve-Path -LiteralPath $ExpectedIcon).Path, $actual.Width, $actual.Height)
$expected = $expectedIconObject.ToBitmap()
try {
  if ($actual.Width -ne $expected.Width -or $actual.Height -ne $expected.Height) {
    throw "Executable icon dimensions differ from the project icon."
  }
  for ($y = 0; $y -lt $actual.Height; $y++) {
    for ($x = 0; $x -lt $actual.Width; $x++) {
      if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) {
        throw "Executable icon differs from the project icon at ($x, $y)."
      }
    }
  }
  Write-Output "Verified Windows icon for $Executable"
} finally {
  $actual.Dispose()
  $expected.Dispose()
  $actualIcon.Dispose()
  $expectedIconObject.Dispose()
}
