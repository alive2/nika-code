<#
	generate-nika-icons.ps1 — Regenerate all NikaCode icon assets from the
	master logo (resources/nika/nika-icon.png).

	Why this script exists:
	The app icon does NOT come from resources/nika/*.png — those files are only
	the editable source artwork. The binaries the build actually consumes are:

	  resources/win32/code.ico        -> exe icon (rcedit) + installer SetupIconFile
	  resources/win32/code_150x150.png-> window icon when running from sources (Windows)
	  resources/win32/code_70x70.png  -> AppX Square44x44Logo
	  resources/linux/code.png        -> window icon (Linux) + Linux packages
	  resources/server/favicon.ico    -> web workbench favicon
	  resources/server/code-192.png   -> server branding (192px)
	  resources/server/code-512.png   -> server branding (512px)

	After updating the master PNG, run this script so the logo change actually
	reaches the app. Windows-only (uses System.Drawing). The .icns (macOS) and
	the Inno wizard bitmaps (resources/win32/inno-*.bmp) are not regenerated
	here.
#>
param(
	[ValidateScript({ Test-Path $_ })]
	[string]$Source = (Join-Path $PSScriptRoot '..\resources\nika\nika-icon.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Resources = Join-Path $PSScriptRoot '..\resources'

function New-ScaledBitmap {
	param([System.Drawing.Image]$Source, [int]$Size)
	$bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$g = [System.Drawing.Graphics]::FromImage($bmp)
	$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
	$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
	$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
	$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
	$g.DrawImage($Source, 0, 0, $Size, $Size)
	$g.Dispose()
	return $bmp
}

# DIB (BITMAPINFOHEADER + bottom-up BGRA + AND mask) payload for small ICO entries.
function ConvertTo-DibBytes {
	param([System.Drawing.Bitmap]$Bmp)
	$w = $Bmp.Width
	$h = $Bmp.Height
	$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
	$data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	try {
		$stride = $data.Stride
		$pixels = New-Object byte[] ($stride * $h)
		[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
	}
 finally {
		$Bmp.UnlockBits($data)
	}

	$ms = New-Object System.IO.MemoryStream
	$bw = New-Object System.IO.BinaryWriter($ms)
	$bw.Write([int32]40)             # biSize
	$bw.Write([int32]$w)             # biWidth
	$bw.Write([int32]($h * 2))       # biHeight (XOR + AND)
	$bw.Write([int16]1)              # biPlanes
	$bw.Write([int16]32)             # biBitCount
	$bw.Write([int32]0)              # biCompression (BI_RGB)
	$bw.Write([int32]0)              # biSizeImage
	$bw.Write([int32]0)              # biXPelsPerMeter
	$bw.Write([int32]0)              # biYPelsPerMeter
	$bw.Write([int32]0)              # biClrUsed
	$bw.Write([int32]0)              # biClrImportant
	for ($y = $h - 1; $y -ge 0; $y--) {
		$bw.Write($pixels, $y * $stride, $stride)
	}
	# AND mask: 1bpp rows padded to 4 bytes, all zero (fully opaque).
	$andRow = New-Object byte[] ([Math]::Ceiling($w / 32.0) * 4)
	for ($y = 0; $y -lt $h; $y++) {
		$bw.Write($andRow)
	}
	$bw.Flush()
	$result = $ms.ToArray()
	$bw.Dispose()
	$ms.Dispose()
	# ,$result keeps the byte[] intact — without it PowerShell unrolls the array
	# into an Object[] and BinaryWriter.Write() would only write a single byte.
	return , $result
}

function ConvertTo-PngBytes {
	param([System.Drawing.Bitmap]$Bmp)
	$ms = New-Object System.IO.MemoryStream
	$Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	$result = $ms.ToArray()
	$ms.Dispose()
	return , $result
}

function New-IcoFile {
	param([System.Drawing.Image]$Source, [string]$Path, [int[]]$Sizes)
	$entries = [System.Collections.ArrayList]::new()
	foreach ($s in $Sizes) {
		$bmp = New-ScaledBitmap $Source $s
		if ($s -eq 256) {
			$data = ConvertTo-PngBytes $bmp   # PNG entry (Vista+) for 256x256
		}
		else {
			$data = ConvertTo-DibBytes $bmp
		}
		$bmp.Dispose()
		[void]$entries.Add(@{ size = $s; data = $data })
	}

	$count = $entries.Count
	$offset = 6 + 16 * $count
	$ms = New-Object System.IO.MemoryStream
	$bw = New-Object System.IO.BinaryWriter($ms)
	$bw.Write([uint16]0)             # ICONDIR.reserved
	$bw.Write([uint16]1)             # ICONDIR.type = icon
	$bw.Write([uint16]$count)
	foreach ($e in $entries) {
		$dim = if ($e.size -ge 256) { 0 } else { $e.size }
		$bw.Write([byte]$dim)        # width (0 = 256)
		$bw.Write([byte]$dim)        # height (0 = 256)
		$bw.Write([byte]0)           # color count
		$bw.Write([byte]0)           # reserved
		$bw.Write([uint16]1)         # planes
		$bw.Write([uint16]32)        # bit count
		$bw.Write([uint32]$e.data.Length)
		$bw.Write([uint32]$offset)
		$offset += $e.data.Length
	}
	foreach ($e in $entries) {
		$bw.Write($e.data)
	}
	$bw.Flush()
	[System.IO.File]::WriteAllBytes($Path, $ms.ToArray())
	$bw.Dispose()
	$ms.Dispose()
}

function Save-ScaledPng {
	param([System.Drawing.Image]$Source, [string]$Path, [int]$Size)
	$bmp = New-ScaledBitmap $Source $Size
	$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
	$bmp.Dispose()
}

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))

try {
	# Windows: exe/installer icon + dev window icon + AppX logos
	New-IcoFile $src (Join-Path $Resources 'win32\code.ico') @(16, 20, 24, 32, 40, 48, 64, 128, 256)
	Save-ScaledPng $src (Join-Path $Resources 'win32\code_150x150.png') 150
	Save-ScaledPng $src (Join-Path $Resources 'win32\code_70x70.png') 70

	# Linux window icon / packages
	Save-ScaledPng $src (Join-Path $Resources 'linux\code.png') 512

	# Server / web
	New-IcoFile $src (Join-Path $Resources 'server\favicon.ico') @(16, 32, 48)
	Save-ScaledPng $src (Join-Path $Resources 'server\code-192.png') 192
	Save-ScaledPng $src (Join-Path $Resources 'server\code-512.png') 512

	Write-Output 'Regenerated icon assets from the master PNG:'
	@('win32\code.ico', 'win32\code_150x150.png', 'win32\code_70x70.png',
		'linux\code.png', 'server\favicon.ico', 'server\code-192.png', 'server\code-512.png') |
	ForEach-Object { Write-Output "  resources\$_" }
}
finally {
	$src.Dispose()
}
