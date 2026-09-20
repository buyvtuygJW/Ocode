#requires -Version 5
<#
  regen-personalize.ps1 - regenerate BOTH patches against current upstream, with two pauses.

    PAUSE 1 -> edit the CORE files (cli logo/ui, tui logo, prompt) -> patches/FinalPERSONALIZE.patch  (mandatory)
    PAUSE 2 -> edit the OPTIONAL X files (transparency + mcp)    -> patches/FinalPersonalizeX.patch (best-effort)

  Then: validate + 3-way apply-check each, base on latest origin/dev, commit as claudedbuildbot, force-push.

  Usage:
    .\regen-personalize.ps1
    .\regen-personalize.ps1 -Message "new logo + mcp tweak" -Ref production

  Notes:
    * You edit the COPIES under %TEMP%\ocode-patchgen (NOT D:\temp). Explorer opens there.
    * Skip a pause (press ENTER without editing) to leave that patch unchanged.
    * The workflow is NOT touched here. Update $CoreFiles / $XFiles if your patch targets move
      (e.g. upstream relocates a file - the download will 404 and tell you).
    * Resets D:\temp's dev to origin/dev first so it can never push a stale workflow/tree
      (discards local commits/tracked changes there; untracked files like this script are kept).
#>
[CmdletBinding()]
param(
  [string]$Ref     = "production",
  [string]$Message = "regen patches ($([DateTime]::Now.ToString('yyyy-MM-dd HH:mm')))",
  [string]$RepoDir = "D:\temp",
  [string]$Branch  = "dev"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Upstream  = "anomalyco/opencode"
$CorePatch = "patches/FinalPERSONALIZE.patch"
$XPatch    = "patches/FinalPersonalizeX.patch"
$CoreFiles = @(
  "packages/opencode/src/cli/logo.ts",
  "packages/opencode/src/cli/ui.ts",
  "packages/tui/src/logo.ts", # TUI home-screen logo (the VISIBLE one; cli/* above are only the CLI banner)
  "packages/opencode/src/session/prompt.ts"
)
$XFiles = @(
  "packages/tui/src/context/theme.tsx",
  "packages/tui/src/app.tsx",
  "packages/opencode/src/mcp/index.ts",
  "packages/opencode/src/session/llm.ts",
  "packages/opencode/src/session/llm/request.ts"
)
$Work = Join-Path $env:TEMP "ocode-patchgen"
$enc  = [System.Text.UTF8Encoding]::new($false)

# -------- locate git (not on PATH here) --------
$GITEXE = $null
foreach ($c in @("z:\PortableGit\cmd\git.exe", "C:\Program Files\Git\cmd\git.exe")) { if (Test-Path $c) { $GITEXE = $c; break } }
if (-not $GITEXE) { try { $GITEXE = (Get-Command git.exe -ErrorAction Stop).Source } catch {} }
if (-not $GITEXE) { throw "git.exe not found." }
function g { & $GITEXE -c "safe.directory=*" @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') -> exit $LASTEXITCODE" } }
function gx { & $GITEXE -c "safe.directory=*" @args }   # non-throwing (for check/diff exit codes)
Write-Host "git : $GITEXE"
Write-Host "work: $Work"

# -------- 1) download all files into one scratch repo --------
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
foreach ($f in ($CoreFiles + $XFiles)) {
  $dest = Join-Path $Work $f
  New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
  Write-Host "pull  $f"
  try   { Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$Upstream/$Ref/$f" -OutFile $dest }
  catch { throw "download failed for '$f' ($Upstream@$Ref) - did upstream move it? Update the file lists. $($_.Exception.Message)" }
}
g -C $Work init -q
g -C $Work config core.autocrlf false
g -C $Work config user.email "patchgen@local"
g -C $Work config user.name  "patchgen"
g -C $Work add -A
g -C $Work commit -q -m base
try { Start-Process explorer.exe $Work } catch {}

# -------- 2) two pauses --------
Write-Host ""
Write-Host "=== PAUSE 1: edit the CORE files (mandatory patch) in $Work ==="
$CoreFiles | ForEach-Object { Write-Host "    $_" }
[void](Read-Host "ENTER when core edits are done (or just ENTER to leave the core patch unchanged)")
Write-Host ""
Write-Host "=== PAUSE 2: edit the OPTIONAL X files (transparency + mcp; best-effort) in $Work ==="
$XFiles | ForEach-Object { Write-Host "    $_" }
[void](Read-Host "ENTER when X edits are done (or just ENTER to leave the X patch unchanged)")

# -------- 3) generate both scoped diffs (both edit-sets are present in the work tree) --------
$coreGen = Join-Path $env:TEMP "gen-core.patch"
$xGen    = Join-Path $env:TEMP "gen-x.patch"
foreach ($f in @($coreGen, $xGen)) { if (Test-Path $f) { Remove-Item $f -Force } }
gx -C $Work diff "--output=$coreGen" -- @CoreFiles
gx -C $Work diff "--output=$xGen"    -- @XFiles
$coreChanged = (Test-Path $coreGen) -and ((Get-Item $coreGen).Length -gt 0)
$xChanged    = (Test-Path $xGen)    -and ((Get-Item $xGen).Length    -gt 0)
if (-not $coreChanged -and -not $xChanged) { Write-Host "No edits detected in either set - nothing to do."; exit 0 }

# -------- 4) reset work tree to pristine, then validate + dry-run apply each --------
gx -C $Work checkout -- .
function CheckPatch($gen, $label, $mandatory) {
  $b = [System.IO.File]::ReadAllBytes($gen)
  $l = ($enc.GetString($b)) -split "`n"
  if (($l | Select-String '^(<<<<<<<|=======|>>>>>>>)').Count -ne 0) { throw "$label patch has conflict markers" }
  if (($l | Select-String '^diff --git a/(patches/|\.github/)').Count -ne 0) { throw "$label patch touches patches/ or .github/" }
  if (($b.Length -ge 3) -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { throw "$label patch has a BOM" }
  gx -C $Work apply --3way --check --whitespace=nowarn $gen
  if ($LASTEXITCODE -ne 0) {
    if ($mandatory) { throw "$label patch fails 3-way apply-check (mandatory - aborting)." }
    Write-Host "  WARNING: $label patch fails apply-check; the build will SKIP it (best-effort) and warn in the release."
  } else {
    Write-Host ("  {0} OK -> {1} file(s), applies clean (3-way), {2} bytes" -f $label, ($l | Select-String '^diff --git').Count, $b.Length)
  }
}
if ($coreChanged) { CheckPatch $coreGen "CORE" $true }
if ($xChanged)    { CheckPatch $xGen    "X"    $false }

# -------- 5) base on latest origin/dev, install changed patches, commit, force-push --------
g  -C $RepoDir fetch origin $Branch
Write-Host "resetting $RepoDir [$Branch] to origin/$Branch ..."
g  -C $RepoDir reset --hard "origin/$Branch"
if ($coreChanged) { Copy-Item $coreGen (Join-Path $RepoDir $CorePatch) -Force; g -C $RepoDir add -- $CorePatch }
if ($xChanged)    { Copy-Item $xGen    (Join-Path $RepoDir $XPatch)    -Force; g -C $RepoDir add -- $XPatch }
gx -C $RepoDir diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host "Generated patches identical to what's on $Branch - nothing to push."; exit 0 }
gx -C $RepoDir diff --cached --stat

# --- optional safety gate: uncomment to eyeball before the irreversible push ---
# [void](Read-Host "Push to $Branch now? (ENTER = push / Ctrl-C = abort)")

g -c user.name="claudedbuildbot" -c user.email="claudedbuildbot@local" -C $RepoDir commit -m $Message
g -C $RepoDir push --force origin $Branch
Write-Host ""
Write-Host "DONE - pushed to '$Branch' as claudedbuildbot -> build triggered."
