$ErrorActionPreference = 'Stop'
$kitRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -Raw -LiteralPath (Join-Path $kitRoot 'package-checksums.json') | ConvertFrom-Json
foreach ($item in $manifest) {
  $path = Join-Path $kitRoot $item.path
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $($item.path)" }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $item.sha256) { throw "Checksum mismatch: $($item.path)" }
}
Write-Output "PASS: $(@($manifest).Count) package files verified (SHA-256)."
