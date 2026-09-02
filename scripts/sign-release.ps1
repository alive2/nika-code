<#
.SYNOPSIS
    Authenticode-signs the NikaCode app binaries and the Inno Setup installer.

.DESCRIPTION
    Signs all executables and native modules in the built app directory
    (D:\Projects\david\VSCode-win32-x64) plus the Inno Setup installer
    (.build\win32-x64\user-setup\NikaCodeSetup-<version>.exe).

    Two signing backends are supported, selected automatically:

      1. Traditional PFX certificate via signtool.exe (Windows SDK)
      2. Azure Trusted Signing via azuresigntool (Microsoft.TrustedSigning.Client)

    Configuration is read from environment variables so no secrets are stored
    in the repository. If no signing configuration is present the script prints
    a notice and exits 0, so the release pipeline keeps working unsigned.

    Environment variables (PFX backend):
      NIKA_SIGN_PFX_PATH        Path to the .pfx file
      NIKA_SIGN_PFX_PASSWORD    PFX password
      NIKA_SIGN_PFX_THUMBPRINT  (optional) SHA-1 thumbprint of a cert already
                                in the certificate store; overrides /f + /p

    Environment variables (Azure Trusted Signing backend):
      NIKA_ATS_ENDPOINT    e.g. https://xxx.codesigning.azure.net
      NIKA_ATS_ACCOUNT     Trusted Signing account name
      NIKA_ATS_CERT        certificate name
      NIKA_ATS_PROFILE     signing profile name
      AZURE_CLIENT_ID      (optional) service principal client id
      AZURE_CLIENT_SECRET  (optional) service principal client secret
      AZURE_TENANT_ID      (optional) tenant id
      NIKA_ATS_EXTRA_ARGS  (optional) extra arguments passed to azuresigntool

    Common:
      NIKA_SIGN_TIMESTAMP_URL  RFC 3161 timestamp server URL
                               (default: http://timestamp.digicert.com)

.EXAMPLE
    $env:NIKA_SIGN_PFX_PATH = 'C:\certs\nika-code.pfx'
    $env:NIKA_SIGN_PFX_PASSWORD = 'hunter2'
    .\scripts\sign-release.ps1

.EXAMPLE
    $env:NIKA_ATS_ENDPOINT = 'https://nika.codesigning.azure.net'
    $env:NIKA_ATS_ACCOUNT = 'nika-signing'
    $env:NIKA_ATS_CERT = 'nika-code'
    $env:NIKA_ATS_PROFILE = 'PublicTrust'
    az login   # or set AZURE_CLIENT_ID/SECRET/TENANT_ID
    .\scripts\sign-release.ps1
#>

[CmdletBinding()]
param(
	# Path to the built app directory (VSCode-win32-x64).
	[string]$AppDir = '',
	# Path to the user-setup output directory.
	[string]$SetupDir = '',
	# Patterns of files to sign inside the app directory.
	[string[]]$AppPatterns = @('*.exe', '*.dll', '*.node'),
	# Skip signing the app binaries (sign only the installer).
	[switch]$SkipAppBinaries
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

if (-not $AppDir) {
	$AppDir = Join-Path (Split-Path $repoRoot -Parent) 'VSCode-win32-x64'
}
if (-not $SetupDir) {
	$SetupDir = Join-Path $repoRoot '.build\win32-x64\user-setup'
}

function Write-Step([string]$Message) {
	Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-Signtool {
	# Prefer signtool on PATH, then the newest Windows SDK copy.
	$cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }

	$kitsRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
	if (Test-Path $kitsRoot) {
		$candidates = Get-ChildItem $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
			Sort-Object FullName -Descending
		if ($candidates) {
			# Prefer the x64 build when multiple Windows SDK versions/architectures are installed.
			$x64 = $candidates | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
			return $(if ($x64) { $x64.FullName } else { $candidates[0].FullName })
		}
	}
	return $null
}

# ---------------------------------------------------------------------------
# 1. Backend detection
# ---------------------------------------------------------------------------
$timestampUrl = if ($env:NIKA_SIGN_TIMESTAMP_URL) { $env:NIKA_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

$usePfX = [bool]$env:NIKA_SIGN_PFX_PATH -or [bool]$env:NIKA_SIGN_PFX_THUMBPRINT
$useAts = [bool]$env:NIKA_ATS_ENDPOINT

if ($usePfX -and $useAts) {
	Write-Error 'Both NIKA_SIGN_PFX_PATH and NIKA_ATS_ENDPOINT are set. Configure only one signing backend.'
	exit 1
}

if (-not $usePfX -and -not $useAts) {
	Write-Host 'No signing backend configured (NIKA_SIGN_PFX_PATH / NIKA_SIGN_PFX_THUMBPRINT / NIKA_ATS_ENDPOINT).' -ForegroundColor Yellow
	Write-Host 'Skipping code signing. See docs/RELEASING.md > Code signing for setup.' -ForegroundColor Yellow
	exit 0
}

$signtool = $null
if ($usePfX) {
	$signtool = Get-Signtool
	if (-not $signtool) {
		Write-Error 'signtool.exe not found. Install the Windows SDK (windows SDK Component "Windows SDK for Desktop C++ x64 Apps") or add it to PATH.'
		exit 1
	}
	Write-Step "Using signtool: $signtool"
	if ($env:NIKA_SIGN_PFX_THUMBPRINT) {
		Write-Step "Signing with certificate thumbprint $($env:NIKA_SIGN_PFX_THUMBPRINT)"
	} else {
		Write-Step "Signing with PFX $($env:NIKA_SIGN_PFX_PATH)"
	}
} else {
	$azuresigntool = Get-Command azuresigntool -ErrorAction SilentlyContinue
	if (-not $azuresigntool) {
		Write-Error 'azuresigntool not found. Install it with:  dotnet tool install --global Microsoft.TrustedSigning.Client'
		exit 1
	}
	Write-Step "Using azuresigntool: $($azuresigntool.Source)"
}

# ---------------------------------------------------------------------------
# 2. Collect files
# ---------------------------------------------------------------------------
$files = [System.Collections.Generic.List[string]]::new()

if (-not $SkipAppBinaries) {
	if (-not (Test-Path $AppDir)) {
		Write-Error "App directory not found: $AppDir (build the app first: npm run gulp vscode-win32-x64)"
		exit 1
	}
	$appFiles = Get-ChildItem $AppDir -Recurse -File -Include $AppPatterns -ErrorAction SilentlyContinue | Where-Object { -not $_.FullName.Contains('\node_modules\') }
	foreach ($f in $appFiles) { $files.Add($f.FullName) }
	Write-Step "Collected $($appFiles.Count) app binaries to sign from $AppDir"
} else {
	Write-Step 'Skipping app binaries (-SkipAppBinaries)'
}

$setupExe = Get-ChildItem $SetupDir -Filter 'NikaCodeSetup-*.exe' -ErrorAction SilentlyContinue |
	Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($setupExe) {
	$files.Add($setupExe.FullName)
	Write-Step "Installer to sign: $($setupExe.FullName)"
} else {
	Write-Warning "No installer found in $SetupDir — skipping it. (Build it first: npm run gulp vscode-win32-x64-user-setup)"
}

if ($files.Count -eq 0) {
	Write-Host 'Nothing to sign.' -ForegroundColor Yellow
	exit 0
}

# ---------------------------------------------------------------------------
# 3. Sign
# ---------------------------------------------------------------------------
$failed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()
$signed = 0
$total = $files.Count

foreach ($file in $files) {
	$signed++
	Write-Host "[$signed/$total] Signing $file" -ForegroundColor DarkGray
	$exitCode = 0
	$outputLines = @()
	try {
		if ($usePfX) {
			$args = @('sign', '/fd', 'SHA256', '/tr', $timestampUrl, '/td', 'SHA256')
			if ($env:NIKA_SIGN_PFX_THUMBPRINT) {
				$args += @('/sha1', $env:NIKA_SIGN_PFX_THUMBPRINT)
			} else {
				$args += @('/f', $env:NIKA_SIGN_PFX_PATH, '/p', $env:NIKA_SIGN_PFX_PASSWORD)
			}
			$args += $file
			$outputLines = @(& $signtool @args 2>&1 | ForEach-Object { "$_" })
			$exitCode = $LASTEXITCODE
		} else {
			$args = @(
				'sign',
				'-e', $env:NIKA_ATS_ENDPOINT,
				'-a', $env:NIKA_ATS_ACCOUNT,
				'-c', $env:NIKA_ATS_CERT,
				'-p', $env:NIKA_ATS_PROFILE,
				'-fd', 'SHA256',
				'-tr', $timestampUrl,
				'-td', 'SHA256'
			)
			if ($env:NIKA_ATS_EXTRA_ARGS) { $args += ($env:NIKA_ATS_EXTRA_ARGS -split ' ') }
			$args += $file
			$outputLines = @(& $azuresigntool.Source @args 2>&1 | ForEach-Object { "$_" })
			$exitCode = $LASTEXITCODE
		}
	} catch {
		$exitCode = 1
		$outputLines = @($_.Exception.Message)
	}

	if ($exitCode -ne 0) {
		$output = ($outputLines -join "`n")
		if ($output -match '0x800700C1|badexeformat|Bad EXE format') {
			# Not a signable PE (e.g. some Rust prebuilt .node shims) — nothing we can do.
			Write-Warning "Skipped (not a signable PE): $file"
			$skipped.Add($file)
		} else {
			Write-Warning "Failed to sign $file (exit $exitCode)"
			foreach ($line in $outputLines | Select-Object -First 4) { Write-Host "  $line" -ForegroundColor DarkGray }
			$failed.Add($file)
		}
	}
}

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------
if ($setupExe -and (Test-Path $setupExe.FullName)) {
	Write-Step 'Verifying installer signature...'
	if ($signtool) {
		& $signtool verify /pa $setupExe.FullName 2>&1 | Out-Host
		if ($LASTEXITCODE -eq 0) {
			Write-Host "OK: installer is Authenticode-signed." -ForegroundColor Green
		} else {
			Write-Warning "Installer signature verification failed (exit $LASTEXITCODE)."
		}
	} else {
		Write-Host 'Skipping verification (signtool not available).' -ForegroundColor Yellow
	}
}

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host "Signed $signed file(s): $($signed - $failed.Count - $skipped.Count) OK, $($skipped.Count) skipped (not signable PE), $($failed.Count) failed" -ForegroundColor $(if ($failed.Count -gt 0) { 'Red' } else { 'Green' })
if ($skipped.Count -gt 0) {
	Write-Host 'Skipped files:' -ForegroundColor Yellow
	$skipped | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}
if ($failed.Count -gt 0) {
	Write-Host "FAILED: $($failed.Count) of $total files could not be signed:" -ForegroundColor Red
	$failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
	exit 1
}
