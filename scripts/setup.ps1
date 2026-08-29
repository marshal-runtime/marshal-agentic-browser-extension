#Requires -Version 5.1
<#
.SYNOPSIS
    Agentic Browser — Windows Setup Script

.DESCRIPTION
    Downloads and installs all prerequisites, builds the CLI tool, and
    registers it globally so you can run "agentic-browser" from any terminal.

    Prerequisites handled:
      - Node.js 22+ (via winget or manual download)
      - npm 10+ (ships with Node.js 22)
      - Google Chrome or Microsoft Edge (at least one must be present)

.EXAMPLE
    # Run from the repo root:
    .\scripts\setup.ps1

    # Or from anywhere:
    powershell -ExecutionPolicy Bypass -File path\to\setup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step { param([string]$msg) Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

function Test-CommandExists { param([string]$cmd) $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------------------
# 0. Locate repo root
# ---------------------------------------------------------------------------

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir

if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    Write-Err "Cannot find package.json in $RepoRoot — run this script from inside the repo."
    exit 1
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Agentic Browser — Windows Setup        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "  Repo: $RepoRoot"

# ---------------------------------------------------------------------------
# 1. Node.js 22+
# ---------------------------------------------------------------------------

Write-Step "Checking Node.js..."

$nodeInstalled = Test-CommandExists 'node'
$nodeVersion = 0

if ($nodeInstalled) {
    $rawVersion = (node --version 2>$null) -replace '^v', ''
    $nodeVersion = [int]($rawVersion -split '\.')[0]
}

if ($nodeVersion -ge 22) {
    Write-Ok "Node.js v$rawVersion found"
} else {
    if ($nodeInstalled) {
        Write-Warn "Node.js v$rawVersion found, but v22+ is required"
    } else {
        Write-Warn "Node.js not found"
    }

    Write-Step "Installing Node.js 22 LTS..."

    # Try winget first (available on Windows 10 1709+ and Windows 11)
    if (Test-CommandExists 'winget') {
        Write-Host "  Using winget..."
        winget install --id OpenJS.NodeJS.LTS --version 22.14.0 --accept-package-agreements --accept-source-agreements 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Node.js installed via winget"
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                        [System.Environment]::GetEnvironmentVariable('Path', 'User')
        } else {
            Write-Warn "winget install failed, trying direct download..."
        }
    }

    # Re-check after winget attempt
    $nodeInstalled = Test-CommandExists 'node'
    if (-not $nodeInstalled) {
        # Direct download fallback
        $installerUrl = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi'
        $installerPath = Join-Path $env:TEMP 'node-v22.14.0-x64.msi'

        Write-Host "  Downloading Node.js 22.14.0 from nodejs.org..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing

        Write-Host "  Running installer (may require admin)..."
        Start-Process msiexec.exe -ArgumentList "/i `"$installerPath`" /qn" -Wait -Verb RunAs
        Remove-Item $installerPath -ErrorAction SilentlyContinue

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    }

    # Final check
    if (Test-CommandExists 'node') {
        $rawVersion = (node --version) -replace '^v', ''
        Write-Ok "Node.js v$rawVersion installed"
    } else {
        Write-Err "Failed to install Node.js. Please install Node.js 22+ manually:"
        Write-Err "  https://nodejs.org/en/download/"
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 2. npm check
# ---------------------------------------------------------------------------

Write-Step "Checking npm..."

if (Test-CommandExists 'npm') {
    $npmVer = (npm --version 2>$null)
    Write-Ok "npm v$npmVer found"
} else {
    Write-Err "npm not found. It should come with Node.js — reinstall Node.js."
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Browser check (Chrome or Edge)
# ---------------------------------------------------------------------------

Write-Step "Checking for a supported browser..."

$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$edgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$chromeFound = $false
$edgeFound   = $false

foreach ($p in $chromePaths) {
    if (Test-Path $p) { $chromeFound = $true; Write-Ok "Google Chrome: $p"; break }
}
foreach ($p in $edgePaths) {
    if (Test-Path $p) { $edgeFound = $true; Write-Ok "Microsoft Edge: $p"; break }
}

if (-not $chromeFound -and -not $edgeFound) {
    Write-Warn "No supported browser found."
    Write-Host "  Installing Google Chrome via winget..."
    if (Test-CommandExists 'winget') {
        winget install --id Google.Chrome --accept-package-agreements --accept-source-agreements 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Google Chrome installed"
        } else {
            Write-Err "Could not install Chrome automatically."
            Write-Err "Please install Google Chrome or Microsoft Edge manually."
            exit 1
        }
    } else {
        Write-Err "winget not available. Please install Google Chrome or Microsoft Edge manually."
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 4. Install npm dependencies
# ---------------------------------------------------------------------------

Write-Step "Installing npm dependencies..."

Push-Location $RepoRoot
try {
    npm install 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Ok "Dependencies installed"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 5. Build the CLI
# ---------------------------------------------------------------------------

Write-Step "Building the CLI..."

Push-Location $RepoRoot
try {
    npm run build:cli 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "CLI build failed" }
    Write-Ok "CLI built successfully"
} finally {
    Pop-Location
}

# Verify the dist exists
$cliEntry = Join-Path $RepoRoot 'packages\cli\dist\index.js'
if (-not (Test-Path $cliEntry)) {
    Write-Err "Build output not found at $cliEntry"
    exit 1
}

# ---------------------------------------------------------------------------
# 6. Link the CLI globally
# ---------------------------------------------------------------------------

Write-Step "Registering 'agentic-browser' CLI globally..."

Push-Location (Join-Path $RepoRoot 'packages\cli')
try {
    npm link 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm link failed" }
    Write-Ok "'agentic-browser' command is now available globally"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------

Write-Step "Verifying installation..."

if (Test-CommandExists 'agentic-browser') {
    Write-Ok "'agentic-browser' is available on PATH"
} else {
    # npm link may need a new shell to pick up PATH changes
    Write-Warn "'agentic-browser' not yet on PATH — open a new terminal and try again."
}

# Quick smoke test
Write-Host "  Running: agentic-browser --help" -ForegroundColor DarkGray
agentic-browser --help 2>$null | Select-Object -First 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   Setup Complete!                        ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor White
Write-Host "    agentic-browser setup              # Launch browser" -ForegroundColor Gray
Write-Host "    agentic-browser navigate `"https://example.com`"" -ForegroundColor Gray
Write-Host "    agentic-browser screenshot --output page.png" -ForegroundColor Gray
Write-Host "    agentic-browser shutdown            # Stop browser" -ForegroundColor Gray
Write-Host ""
Write-Host "  For the full command reference, see:" -ForegroundColor White
Write-Host "    SKILL.md (root of this repo)" -ForegroundColor Gray
Write-Host ""
