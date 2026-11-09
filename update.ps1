# ============================================================
#  Copy the latest downloaded files into the project.
#
#    powershell -ExecutionPolicy Bypass -File update.ps1
#
#  These files change as a set. Copying only some of them is
#  what produces errors like a group booking rejected as
#  "name_required", so this moves them together and then
#  checks each one actually landed.
# ============================================================

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$downloads = Join-Path $env:USERPROFILE 'Downloads'

# file name -> where it belongs, and a string proving it's current
$files = @(
  @{ name = 'index.html';   dest = '.';             marker = 'checkZone' }
  @{ name = 'admin.html';   dest = '.';             marker = 'zoneFields' }
  @{ name = 'guide.html';   dest = '.';             marker = 'Travel zones' }
  @{ name = 'db.js';        dest = 'src';           marker = 'zone_limits' }
  @{ name = 'seats.js';     dest = 'src';           marker = 'zoneTripsLeft' }
  @{ name = 'server.js';    dest = 'src';           marker = 'bulk-days' }
  @{ name = 'zones.js';     dest = 'src';           marker = 'zoneForZip' }
  @{ name = 'zip-centroids.json'; dest = 'src';     marker = '"97116"' }
  @{ name = 'calendar.js';  dest = 'src';           marker = 'BEGIN:VCALENDAR' }
  @{ name = 'address.js';   dest = 'src';           marker = 'PHOTON_URL' }
  @{ name = 'seed.js';      dest = 'src';           marker = 'WORKDAY' }
  @{ name = 'mock.js';      dest = 'src\payments';  marker = 'MOCK PAYMENT' }
  @{ name = 'converge.js';  dest = 'src\payments';  marker = 'PayWithConverge' }
  @{ name = 'package.json'; dest = '.';             marker = 'test:zones' }
  @{ name = 'seats.test.js';    dest = 'test';      marker = 'the OS will clear it' }
  @{ name = 'slots.test.js';    dest = 'test';      marker = 'the OS will clear it' }
  @{ name = 'address.test.js';  dest = 'test';      marker = 'Photon parsing' }
  @{ name = 'frontend.test.js'; dest = 'test';      marker = 'already closed' }
  @{ name = 'admin.test.js';    dest = 'test';      marker = 'already closed' }
  @{ name = 'e2e.sh';           dest = 'test';      marker = 'created from the admin API' }
  @{ name = 'pricing.test.js';  dest = 'test';      marker = 'the OS will clear it' }
  @{ name = 'zones.test.js';    dest = 'test';      marker = 'trips per zone per day' }
)

# Selecting several files at once makes the browser hand back a single zip,
# so unpack the newest one into Downloads before looking for loose files.
$zip = Get-ChildItem $downloads -Filter 'files*.zip' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($zip) {
  # Earlier runs left loose copies in Downloads. A file from a previous batch
  # can be newer than one in this zip and quietly win, so clear the ones this
  # script manages before unpacking.
  foreach ($f in $files) {
    $old = Join-Path $downloads $f.name
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
  }

  $stage = Join-Path $downloads 'spectrum-unpacked'
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip.FullName -DestinationPath $stage -Force
  Get-ChildItem $stage -Recurse -File | Move-Item -Destination $downloads -Force
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host ("  Unpacked {0}" -f $zip.Name) -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Updating from Downloads' -ForegroundColor Cyan
Write-Host ''

foreach ($f in $files) {
  # Accept the exact name, or a browser duplicate like "server (1).js" —
  # but nothing else. A wildcard here would let "seats.test.js" be copied
  # over "seats.js", which is a quiet and very confusing way to break things.
  $base = [IO.Path]::GetFileNameWithoutExtension($f.name)
  $ext  = [IO.Path]::GetExtension($f.name)
  $pattern = '^' + [regex]::Escape($base) + '( \(\d+\))?' + [regex]::Escape($ext) + '$'

  $found = Get-ChildItem $downloads -File -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match $pattern } |
           Sort-Object LastWriteTime -Descending |
           Select-Object -First 1

  if (-not $found) {
    Write-Host ("    - {0,-14} not in Downloads, skipped" -f $f.name) -ForegroundColor DarkGray
    continue
  }

  New-Item -ItemType Directory -Force -Path $f.dest | Out-Null
  $target = Join-Path $f.dest $f.name
  Copy-Item $found.FullName $target -Force
  Write-Host ("    + {0,-14} <- {1}" -f $f.name, $found.Name) -ForegroundColor Green
}

Write-Host ''
Write-Host '  Checking what is on disk' -ForegroundColor Cyan
Write-Host ''

$stale = 0
foreach ($f in $files) {
  $path = Join-Path $f.dest $f.name
  if (-not (Test-Path $path)) {
    Write-Host ("    MISSING  {0}" -f $path) -ForegroundColor Red
    $stale++
    continue
  }
  if (Select-String -Path $path -Pattern $f.marker -Quiet) {
    Write-Host ("    ok       {0}" -f $path) -ForegroundColor Green
  } else {
    Write-Host ("    OLD      {0}  (download it again)" -f $path) -ForegroundColor Red
    $stale++
  }
}

Write-Host ''
if ($stale -eq 0) {
  Write-Host '  Everything is current. Run start.bat.' -ForegroundColor Green
} else {
  Write-Host ("  {0} file(s) still need attention." -f $stale) -ForegroundColor Yellow
}
Write-Host ''
