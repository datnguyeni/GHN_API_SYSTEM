[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$CrmRoot)
$ErrorActionPreference = 'Stop'
$kitRoot = Split-Path $PSScriptRoot -Parent
$targetRoot = (Resolve-Path -LiteralPath $CrmRoot).Path
if (!(Test-Path -LiteralPath (Join-Path $targetRoot 'backend/pom.xml')) -or
    !(Test-Path -LiteralPath (Join-Path $targetRoot 'frontend/package.json'))) {
  throw 'CrmRoot must be an existing CRM checkout with backend/pom.xml and frontend/package.json.'
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $kitRoot 'source-manifest.json') | ConvertFrom-Json
$plan = foreach ($item in $manifest.files) {
  $relative = $item.packaged
  if ($relative.StartsWith('integration/crm-overlay/')) {
    $relative = $relative.Substring('integration/crm-overlay/'.Length)
  } elseif (!$relative.StartsWith('backend/') -and !$relative.StartsWith('frontend/')) { continue }
  $src = Join-Path $kitRoot $item.packaged
  if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -ne $item.sha256) { throw "Package source modified: $($item.packaged)" }
  $dst = Join-Path $targetRoot $relative
  if (Test-Path -LiteralPath $dst) {
    if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash -ne $item.sha256) {
      throw "Merge required; no files copied. Different existing file: $dst"
    }
    continue
  }
  [pscustomobject]@{source=$src;destination=$dst}
}
foreach ($item in $plan) {
  if ($PSCmdlet.ShouldProcess($item.destination, 'Add Shipping source')) {
    New-Item -ItemType Directory -Force -Path (Split-Path $item.destination) | Out-Null
    Copy-Item -LiteralPath $item.source -Destination $item.destination
  }
}
Write-Output "Checked package source. New files planned: $(@($plan).Count). Review docs/INTEGRATION.md for module registration, database and build."
