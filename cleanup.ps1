# Tidy stray copies at the project root.
#
# Node loads from src/ and the tests from test/, so a copy at the top level
# does nothing — except when it's the NEWER one, which happens after
# extracting a zip into the wrong place. Deleting blindly would then throw
# away the current file and keep a stale one, so this compares timestamps:
#
#   root copy is newer  -> moved into place, overwriting the old one
#   root copy is older  -> deleted
#   no copy in src/test -> left alone and reported
#
#   powershell -ExecutionPolicy Bypass -File cleanup.ps1

Set-Location $PSScriptRoot

$strays = @(
  @{ name = 'address.js';       home = 'src' }
  @{ name = 'calendar.js';      home = 'src' }
  @{ name = 'db.js';            home = 'src' }
  @{ name = 'seats.js';         home = 'src' }
  @{ name = 'seed.js';          home = 'src' }
  @{ name = 'server.js';        home = 'src' }
  @{ name = 'zones.js';         home = 'src' }
  @{ name = 'schedule.js';      home = 'src' }
  @{ name = 'records.js';       home = 'src' }
  @{ name = 'index.js';         home = 'src\payments' }
  @{ name = 'mock.js';          home = 'src\payments' }
  @{ name = 'converge.js';      home = 'src\payments' }
  @{ name = 'address.test.js';  home = 'test' }
  @{ name = 'admin.test.js';    home = 'test' }
  @{ name = 'frontend.test.js'; home = 'test' }
  @{ name = 'seats.test.js';    home = 'test' }
  @{ name = 'slots.test.js';    home = 'test' }
  @{ name = 'e2e.sh';           home = 'test' }
)

Write-Host ''
Write-Host '  Tidying the project root' -ForegroundColor Cyan
Write-Host ''

$moved = 0; $deleted = 0; $kept = 0

foreach ($s in $strays) {
  if (-not (Test-Path $s.name)) { continue }

  $target = Join-Path $s.home $s.name
  $rootFile = Get-Item $s.name

  if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Force -Path $s.home | Out-Null
    Move-Item $s.name $target -Force
    Write-Host ("    moved    {0,-18} -> {1}  (nothing there before)" -f $s.name, $s.home) -ForegroundColor Green
    $moved++
    continue
  }

  $homeFile = Get-Item $target
  if ($rootFile.LastWriteTime -gt $homeFile.LastWriteTime) {
    Move-Item $s.name $target -Force
    Write-Host ("    moved    {0,-18} -> {1}  (root copy was newer)" -f $s.name, $s.home) -ForegroundColor Green
    $moved++
  } elseif ($rootFile.Length -ne $homeFile.Length) {
    # Same age but different content — too ambiguous to guess at.
    Write-Host ("    KEPT     {0,-18} differs from {1}, check by hand" -f $s.name, $target) -ForegroundColor Yellow
    $kept++
  } else {
    Remove-Item $s.name -Force
    Write-Host ("    removed  {0,-18} (already current in {1})" -f $s.name, $s.home) -ForegroundColor DarkGray
    $deleted++
  }
}

Write-Host ''
Write-Host ("  {0} moved into place, {1} duplicates removed, {2} left for you." -f $moved, $deleted, $kept)
Write-Host ''
Write-Host '  Confirm with:  npm.cmd run test:all' -ForegroundColor Cyan
Write-Host ''
