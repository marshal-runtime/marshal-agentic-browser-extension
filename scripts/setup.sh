#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# Agentic Browser — Linux / macOS Setup Script
#
# Downloads and installs all prerequisites, builds the CLI tool, and
# registers it globally so you can run "agentic-browser" from any terminal.
#
# Prerequisites handled:
#   - Node.js 22+ (via nvm, apt, dnf, brew, or direct download)
#   - npm 10+     (ships with Node.js 22)
#   - Google Chrome or Chromium (installed if missing, Linux only)
#
# Usage:
#   chmod +x scripts/setup.sh
#   ./scripts/setup.sh
# ───────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'

step()  { echo -e "\n${CYAN}▸ $1${RESET}"; }
ok()    { echo -e "  ${GREEN}✓ $1${RESET}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${RESET}"; }
fail()  { echo -e "  ${RED}✗ $1${RESET}"; }
info()  { echo -e "  ${DIM}$1${RESET}"; }

command_exists() { command -v "$1" &>/dev/null; }

# ---------------------------------------------------------------------------
# 0. Locate repo root
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$REPO_ROOT/package.json" ]]; then
    fail "Cannot find package.json in $REPO_ROOT — run this script from inside the repo."
    exit 1
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║   Agentic Browser — Setup                ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo "  Repo: $REPO_ROOT"
echo "  OS:   $(uname -s) $(uname -m)"

# ---------------------------------------------------------------------------
# 1. Node.js 22+
# ---------------------------------------------------------------------------

step "Checking Node.js..."

NODE_OK=false
if command_exists node; then
    NODE_VER=$(node --version | sed 's/^v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    if [[ "$NODE_MAJOR" -ge 22 ]]; then
        ok "Node.js v$NODE_VER found"
        NODE_OK=true
    else
        warn "Node.js v$NODE_VER found, but v22+ is required"
    fi
else
    warn "Node.js not found"
fi

if [[ "$NODE_OK" == false ]]; then
    step "Installing Node.js 22..."

    # Strategy 1: nvm (preferred — no sudo needed)
    if command_exists nvm || [[ -s "$HOME/.nvm/nvm.sh" ]]; then
        [[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh"
        info "Using nvm..."
        nvm install 22
        nvm use 22
        ok "Node.js $(node --version) installed via nvm"

    # Strategy 2: Homebrew (macOS / Linux)
    elif command_exists brew; then
        info "Using Homebrew..."
        brew install node@22
        brew link --overwrite node@22 2>/dev/null || true
        ok "Node.js $(node --version) installed via Homebrew"

    # Strategy 3: apt (Debian / Ubuntu)
    elif command_exists apt-get; then
        info "Using apt (NodeSource)..."
        # Install NodeSource repo for Node.js 22
        if command_exists curl; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        elif command_exists wget; then
            wget -qO- https://deb.nodesource.com/setup_22.x | sudo -E bash -
        fi
        sudo apt-get install -y nodejs
        ok "Node.js $(node --version) installed via apt"

    # Strategy 4: dnf (Fedora / RHEL)
    elif command_exists dnf; then
        info "Using dnf (NodeSource)..."
        if command_exists curl; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        fi
        sudo dnf install -y nodejs
        ok "Node.js $(node --version) installed via dnf"

    # Strategy 5: Direct binary download (universal fallback)
    else
        info "Downloading Node.js 22 binary..."
        ARCH=$(uname -m)
        case "$ARCH" in
            x86_64)  NODE_ARCH="x64" ;;
            aarch64) NODE_ARCH="arm64" ;;
            armv7l)  NODE_ARCH="armv7l" ;;
            *)       fail "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        OS=$(uname -s | tr '[:upper:]' '[:lower:]')
        NODE_TAR="node-v22.14.0-${OS}-${NODE_ARCH}.tar.xz"
        NODE_URL="https://nodejs.org/dist/v22.14.0/${NODE_TAR}"

        TMPDIR_NODE=$(mktemp -d)
        curl -fsSL "$NODE_URL" | tar -xJ -C "$TMPDIR_NODE" --strip-components=1
        sudo cp -r "$TMPDIR_NODE"/* /usr/local/
        rm -rf "$TMPDIR_NODE"
        ok "Node.js $(node --version) installed to /usr/local"
    fi

    # Verify
    if ! command_exists node; then
        fail "Failed to install Node.js. Please install Node.js 22+ manually:"
        fail "  https://nodejs.org/en/download/"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# 2. npm check
# ---------------------------------------------------------------------------

step "Checking npm..."

if command_exists npm; then
    ok "npm v$(npm --version) found"
else
    fail "npm not found. It should come with Node.js — reinstall Node.js."
    exit 1
fi

# ---------------------------------------------------------------------------
# 3. Browser check (Chrome / Chromium / Edge)
# ---------------------------------------------------------------------------

step "Checking for a supported browser..."

BROWSER_FOUND=false

# Chrome / Chromium paths
CHROME_CANDIDATES=(
    /usr/bin/google-chrome
    /usr/bin/google-chrome-stable
    /usr/bin/chromium
    /usr/bin/chromium-browser
    /snap/bin/chromium
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)

EDGE_CANDIDATES=(
    /usr/bin/microsoft-edge
    /usr/bin/microsoft-edge-stable
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
)

for p in "${CHROME_CANDIDATES[@]}"; do
    if [[ -x "$p" ]] || [[ -f "$p" ]]; then
        ok "Chrome/Chromium: $p"
        BROWSER_FOUND=true
        break
    fi
done

if [[ "$BROWSER_FOUND" == false ]]; then
    for p in "${EDGE_CANDIDATES[@]}"; do
        if [[ -x "$p" ]] || [[ -f "$p" ]]; then
            ok "Microsoft Edge: $p"
            BROWSER_FOUND=true
            break
        fi
    done
fi

if [[ "$BROWSER_FOUND" == false ]]; then
    warn "No supported browser found. Attempting to install..."

    OS_TYPE=$(uname -s)
    if [[ "$OS_TYPE" == "Linux" ]]; then
        if command_exists apt-get; then
            info "Installing Chromium via apt..."
            sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
            ok "Chromium installed"
        elif command_exists dnf; then
            info "Installing Chromium via dnf..."
            sudo dnf install -y chromium
            ok "Chromium installed"
        elif command_exists snap; then
            info "Installing Chromium via snap..."
            sudo snap install chromium
            ok "Chromium installed"
        else
            fail "Cannot auto-install a browser. Please install Google Chrome or Chromium manually."
            exit 1
        fi
    elif [[ "$OS_TYPE" == "Darwin" ]]; then
        if command_exists brew; then
            info "Installing Google Chrome via Homebrew..."
            brew install --cask google-chrome
            ok "Google Chrome installed"
        else
            fail "Install Google Chrome manually: https://www.google.com/chrome/"
            exit 1
        fi
    else
        fail "Unsupported OS. Please install Google Chrome or Chromium manually."
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# 4. Install npm dependencies
# ---------------------------------------------------------------------------

step "Installing npm dependencies..."

cd "$REPO_ROOT"
npm install 2>&1 | sed 's/^/  /'
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# 5. Build the CLI
# ---------------------------------------------------------------------------

step "Building the CLI..."

npm run build:cli 2>&1 | sed 's/^/  /'
ok "CLI built successfully"

# Verify
CLI_ENTRY="$REPO_ROOT/packages/cli/dist/index.js"
if [[ ! -f "$CLI_ENTRY" ]]; then
    fail "Build output not found at $CLI_ENTRY"
    exit 1
fi

# ---------------------------------------------------------------------------
# 6. Link the CLI globally
# ---------------------------------------------------------------------------

step "Registering 'agentic-browser' CLI globally..."

cd "$REPO_ROOT/packages/cli"

# Try without sudo first (works if npm prefix is user-writable, e.g. nvm)
if npm link 2>/dev/null; then
    ok "'agentic-browser' command is now available globally"
else
    info "Retrying with sudo..."
    sudo npm link
    ok "'agentic-browser' command is now available globally (via sudo)"
fi

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------

step "Verifying installation..."

if command_exists agentic-browser; then
    ok "'agentic-browser' is available on PATH"
    info "$(agentic-browser --help 2>&1 | head -3)"
else
    warn "'agentic-browser' not yet on PATH — open a new terminal and try again."
    warn "Or run directly: node $CLI_ENTRY"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║   Setup Complete!                        ║${RESET}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "  Quick start:"
echo "    agentic-browser setup              # Launch browser"
echo "    agentic-browser navigate \"https://example.com\""
echo "    agentic-browser screenshot --output page.png"
echo "    agentic-browser shutdown            # Stop browser"
echo ""
echo "  For the full command reference, see:"
echo "    SKILL.md (root of this repo)"
echo ""
