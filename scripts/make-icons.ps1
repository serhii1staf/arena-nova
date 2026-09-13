<#
.SYNOPSIS
  Regenerates every app icon in the project from one source image.

.DESCRIPTION
  One source, one script, so the taskbar, the installer, the updater's shortcut, the
  browser tab and the start screen can never drift apart. Run it again whenever the logo
  changes rather than resizing anything by hand.

  Outputs:
    src-tauri/icons/32x32.png          Windows small
    src-tauri/icons/128x128.png        Linux / general
    src-tauri/icons/128x128@2x.png     256 px, for high-DPI
    src-tauri/icons/icon.png           1024 px master, used by macOS and Linux packaging
    src-tauri/icons/icon.ico           multi-size, what Explorer and the taskbar read
    public/icon-192.png                web install / Android
    public/icon-512.png                web install, splash
    public/apple-touch-icon.png        180 px, iOS home screen
    public/favicon.ico                 multi-size, browser tab
    public/logo.png                    512 px, shown on the start screen

  The .ico files hold PNG-compressed entries rather than raw DIBs. Windows has read those
  since Vista and every browser accepts them, and it keeps a 256 px entry from costing a
  quarter of a megabyte.

.EXAMPLE
  ./scripts/make-icons.ps1 -Source C:\path\to\logo.png
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Source
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'src-tauri/icons'
$pubDir = Join-Path $root 'public'
New-Item -ItemType Directory -Force -Path $iconDir, $pubDir | Out-Null

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
Write-Host "source $($src.Width)x$($src.Height)"

function Save-Png {
  param([int]$Size, [string]$Path)
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size,
    ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    # Bicubic with high-quality pixel offset: the source has rounded corners and a thin
    # border, and a nearest-neighbour or low-quality resample turns both into stair steps
    # at 32 px, which is the size most people actually see.
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $Size, $Size))
  } finally {
    $g.Dispose()
  }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  {0,-34} {1} px" -f (Split-Path $Path -Leaf), $Size)
}

function Save-Ico {
  param([int[]]$Sizes, [string]$Path)
  # Each entry is a whole PNG file embedded in the archive.
  $blobs = foreach ($s in $Sizes) {
    $tmp = [System.IO.Path]::GetTempFileName()
    Save-Png -Size $s -Path $tmp
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    Remove-Item $tmp -Force
    [pscustomobject]@{ Size = $s; Bytes = $bytes }
  }

  $fs = [System.IO.File]::Create($Path)
  $w = New-Object System.IO.BinaryWriter $fs
  try {
    $w.Write([uint16]0)               # reserved
    $w.Write([uint16]1)               # type: icon
    $w.Write([uint16]$blobs.Count)
    # Directory entries come first, so every image offset has to account for all of them.
    $offset = 6 + 16 * $blobs.Count
    foreach ($b in $blobs) {
      # 256 is stored as 0: the field is a single byte.
      $w.Write([byte]($(if ($b.Size -ge 256) { 0 } else { $b.Size })))
      $w.Write([byte]($(if ($b.Size -ge 256) { 0 } else { $b.Size })))
      $w.Write([byte]0)               # palette entries
      $w.Write([byte]0)               # reserved
      $w.Write([uint16]1)             # colour planes
      $w.Write([uint16]32)            # bits per pixel
      $w.Write([uint32]$b.Bytes.Length)
      $w.Write([uint32]$offset)
      $offset += $b.Bytes.Length
    }
    foreach ($b in $blobs) { $w.Write($b.Bytes) }
  } finally {
    $w.Dispose()
    $fs.Dispose()
  }
  Write-Host ("  {0,-34} {1}" -f (Split-Path $Path -Leaf), ($Sizes -join '/'))
}

Write-Host 'desktop:'
Save-Png -Size 32   -Path (Join-Path $iconDir '32x32.png')
Save-Png -Size 128  -Path (Join-Path $iconDir '128x128.png')
Save-Png -Size 256  -Path (Join-Path $iconDir '128x128@2x.png')
Save-Png -Size 1024 -Path (Join-Path $iconDir 'icon.png')
Save-Ico -Sizes 16, 24, 32, 48, 64, 128, 256 -Path (Join-Path $iconDir 'icon.ico')

Write-Host 'web:'
Save-Png -Size 192 -Path (Join-Path $pubDir 'icon-192.png')
Save-Png -Size 512 -Path (Join-Path $pubDir 'icon-512.png')
Save-Png -Size 180 -Path (Join-Path $pubDir 'apple-touch-icon.png')
Save-Png -Size 512 -Path (Join-Path $pubDir 'logo.png')
Save-Ico -Sizes 16, 32, 48 -Path (Join-Path $pubDir 'favicon.ico')

$src.Dispose()
Write-Host 'done'
