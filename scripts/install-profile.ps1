<#
.SYNOPSIS
  Mount dsh-mysql-studio into a DSH web profile.

.DESCRIPTION
  Adds this checkout to the profile as a `link:` dependency and lists the package
  in `dsh.profile.bundles`, then runs `pnpm install` so the profile's
  node_modules gains the link the loader resolves by package name.

  The profile's package.json is edited by targeted text insertion rather than a
  parse/serialize round trip, so unrelated formatting and key order survive
  untouched. The original is backed up first.

  Idempotent: running it twice changes nothing the second time.

  This file is deliberately ASCII-only. Windows PowerShell 5.1 reads a script
  without a byte-order mark as ANSI, so non-ASCII text here would be mangled on
  a machine whose active code page is not UTF-8 -- and the parse error would
  point at an unrelated line.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
  # Profile directory name under <dsh-home>/profiles.
  [string]$Profile = 'web',
  # DSH home; defaults to $env:DSH_HOME, then ~/.dsh.
  [string]$DshHome,
  # Edit package.json but do not run pnpm install.
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome -or $DshHome -eq '') {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path $manifestPath)) {
  throw "Profile manifest not found: $manifestPath (run 'dsh web' once to initialise the profile directory)"
}

$packageName = 'dsh-mysql-studio'
# pnpm accepts either separator; the forward-slash form diffs better.
$linkTarget = $repoRoot -replace '\\', '/'

Write-Host "repo     : $repoRoot"
Write-Host "profile  : $profileDir"
Write-Host "link     : $linkTarget"

# ---- locate pnpm ----------------------------------------------------------
$pnpmPath = $null
$pnpmCommand = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
if ($pnpmCommand) {
  $pnpmPath = $pnpmCommand.Source
} else {
  $fallback = Join-Path $env:LOCALAPPDATA 'pnpm\bin\pnpm.CMD'
  if (Test-Path $fallback) { $pnpmPath = $fallback }
}

# ---- the plugin's own dependencies ----------------------------------------
# Installed FIRST, and this is not optional. The plugin must carry its own
# database driver: a `link:` install does not pull a linked package's
# dependencies, so without this the plugin would be relying on some OTHER plugin
# happening to provide mysql2 -- a mistake this project already made once, when
# the plugin that did provide it was reinstalled away and left this one broken on
# the next boot.
if ($SkipInstall) {
  Write-Host 'Skipping dependency installs (-SkipInstall).'
} elseif (-not $pnpmPath) {
  Write-Warning 'pnpm not found. Run `pnpm install` in BOTH the plugin directory and the profile directory.'
} else {
  Write-Host "installing the plugin's own dependencies"
  Push-Location $repoRoot
  try {
    & $pnpmPath install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install (plugin) exited with $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  if (Test-Path (Join-Path $repoRoot 'node_modules\mysql2')) {
    Write-Host '  node_modules\mysql2 is in place (the plugin is self-contained)'
  } else {
    Write-Warning "node_modules\mysql2 did not appear -- the plugin would depend on another package's driver."
    exit 4
  }
}

$original = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$text = $original

# ---- dependencies ---------------------------------------------------------
$depPattern = '"' + [regex]::Escape($packageName) + '"\s*:'
if ($text -notmatch $depPattern) {
  $depsAnchor = [regex]::Match($text, '"dependencies"\s*:\s*\{')
  if (-not $depsAnchor.Success) {
    throw "No dependencies block in the profile manifest. Add manually: ""$packageName"": ""link:$linkTarget"""
  }
  $insertAt = $depsAnchor.Index + $depsAnchor.Length
  $line = "`n    ""$packageName"": ""link:$linkTarget"","
  $text = $text.Insert($insertAt, $line)
  Write-Host "  + dependencies <- $packageName"
} else {
  Write-Host "  = dependencies already has $packageName"
}

# ---- dsh.profile.bundles --------------------------------------------------
$bundlesMatch = [regex]::Match($text, '"bundles"\s*:\s*\[')
if (-not $bundlesMatch.Success) {
  throw "No dsh.profile.bundles block in the profile manifest. Add ""$packageName"" to bundles manually."
}
$bundlesStart = $bundlesMatch.Index + $bundlesMatch.Length
$bundlesEnd = $text.IndexOf(']', $bundlesStart)
if ($bundlesEnd -lt 0) { throw 'Unclosed ] in the bundles array.' }
$bundlesBody = $text.Substring($bundlesStart, $bundlesEnd - $bundlesStart)
$bundleEntryPattern = '"' + [regex]::Escape($packageName) + '"'

if ($bundlesBody -notmatch $bundleEntryPattern) {
  # Append as the LAST layer, which is where a profile's own additions belong:
  # later layers win, so this patch is applied after every shipped bundle.
  # The newline and indent that sat before `]` are preserved, and the previous
  # entry gains the comma it needs -- inserting a bare line before `]` would
  # produce an unterminated pair.
  $before = $text.Substring(0, $bundlesEnd)
  $after = $text.Substring($bundlesEnd)
  $trimmed = $before.TrimEnd()
  $gap = $before.Substring($trimmed.Length)
  $separator = if ($trimmed.EndsWith('[')) { '' } else { ',' }
  $text = $trimmed + $separator + "`n        ""$packageName""" + $gap + $after
  Write-Host "  + bundles <- $packageName"
} else {
  Write-Host "  = bundles already has $packageName"
}

# ---- write ----------------------------------------------------------------
if ($text -ne $original) {
  # Validate before touching disk: a malformed manifest breaks the whole boot.
  try {
    $null = $text | ConvertFrom-Json
  } catch {
    throw "Refusing to write: the edited manifest is not valid JSON. $($_.Exception.Message)"
  }
  $backup = "$manifestPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $manifestPath $backup -Force
  Write-Host "  backup: $backup"
  # Written through .NET, not Set-Content: Windows PowerShell 5.1's
  # `-Encoding utf8` emits a BOM, and a BOM makes package.json unparseable.
  [System.IO.File]::WriteAllText($manifestPath, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  wrote $manifestPath"
} else {
  Write-Host "  manifest unchanged"
}

if ($SkipInstall) {
  Write-Host 'Skipped the profile install (-SkipInstall).'
  exit 0
}

# ---- the profile link -----------------------------------------------------
if (-not $pnpmPath) {
  Write-Warning 'pnpm not found. Run `pnpm install` in the profile directory; node_modules must end up containing dsh-mysql-studio.'
  exit 2
}

Write-Host "running: $pnpmPath install"
Push-Location $profileDir
try {
  & $pnpmPath install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install (profile) exited with $LASTEXITCODE" }
} finally {
  Pop-Location
}

$linked = Join-Path $profileDir "node_modules\$packageName"
if (Test-Path $linked) {
  Write-Host "  node_modules\$packageName is in place"
} else {
  Write-Warning "node_modules\$packageName did not appear; the loader cannot resolve the package by name."
  exit 3
}

Write-Host ''
Write-Host 'Install complete. Restart dsh web, then hard-refresh the browser (Ctrl+Shift+R).'
