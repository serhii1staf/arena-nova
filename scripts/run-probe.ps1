<#
.SYNOPSIS
  Runs one Playwright probe without taking the machine over.

.DESCRIPTION
  The probes launch a real Chromium and render the whole game in it. They do that with
  `--use-angle=swiftshader`, which means the scene is rasterised *in software, on the CPU* —
  so a probe is not a script that pokes at a page, it is a second copy of the game being
  drawn by the processor. Left at normal priority it saturates every core for the minute or
  two it runs, and the machine becomes unusable while it does.

  Two limits, both inherited by the Chromium that Node launches:

    * Idle priority, so anything the user is doing wins every scheduling decision.
    * An affinity mask covering half the cores, so the other half is never contended at
      all rather than merely deprioritised.

  Affinity is the one that actually guarantees responsiveness. Priority alone still lets a
  fully parallel rasteriser occupy every core between the user's own timeslices.

.EXAMPLE
  ./scripts/run-probe.ps1 build
  ./scripts/run-probe.ps1 craft
  ./scripts/run-probe.ps1 squadsight
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('build', 'craft', 'squadsight', 'admin', 'net', 'snow')]
  [string]$Probe,

  # Fraction of cores the probe may use. Half by default.
  [ValidateRange(0.125, 1.0)]
  [double]$CoreShare = 0.5,

  # Generous, because throttling is the point: on half the cores at idle priority a probe
  # takes something like two and a half times as long as it does unthrottled. That is the
  # trade being made deliberately — the machine stays usable while it runs. Still finite, so
  # a genuine hang is reported instead of waited out.
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot "debug-$Probe.mjs"
if (-not (Test-Path $script)) { throw "no such probe: $script" }

$total = [Environment]::ProcessorCount
$allowed = [Math]::Max(1, [int][Math]::Floor($total * $CoreShare))
# The low `$allowed` bits set: cores 0..$allowed-1.
$mask = [int64]([Math]::Pow(2, $allowed) - 1)

$out = Join-Path $env:TEMP "arena-probe-$Probe.out.txt"
$err = Join-Path $env:TEMP "arena-probe-$Probe.err.txt"
Remove-Item $out, $err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath 'node' -ArgumentList $script -WorkingDirectory $root `
  -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err

try {
  # Set before the browser is spawned where possible; children inherit both.
  $p.PriorityClass = 'Idle'
  $p.ProcessorAffinity = [IntPtr]$mask
} catch {
  Write-Warning "could not throttle pid $($p.Id): $($_.Exception.Message)"
}

Write-Host "probe=$Probe pid=$($p.Id) cores=$allowed/$total priority=Idle"

if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
  # A probe that overruns leaves a Chromium behind if it is merely abandoned, so the tree
  # is killed rather than the shell being walked away from. That is what happened when a run
  # was cancelled from outside: the wrapper died and the rasteriser kept going.
  Write-Warning "probe=$Probe exceeded ${TimeoutSeconds}s; killing the process tree"
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {}
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.Id)" -ErrorAction SilentlyContinue |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}

if (Test-Path $out) { Get-Content $out }
if (Test-Path $err) { Get-Content $err | Where-Object { $_ -match '\S' } }
exit $p.ExitCode
