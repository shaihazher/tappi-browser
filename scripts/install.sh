#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tappi Browser — Universal Installer
# https://github.com/shaihazher/tappi-browser
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shaihazher/tappi-browser/main/scripts/install.sh | bash
#
# Environment variables:
#   TAPPI_INSTALL_DIR  — override install location (default: ~/.local/share/tappi-browser)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="https://github.com/shaihazher/tappi-browser.git"
DEFAULT_INSTALL_DIR="${HOME}/.local/share/tappi-browser"
INSTALL_DIR="${TAPPI_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
BIN_DIR="${HOME}/.local/bin"
MIN_NODE_MAJOR=18

# ── Colors ────────────────────────────────────────────────────────────────────

if [ -t 1 ] || [ -t 2 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' RESET=''
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { printf "${CYAN}▸${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✔${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*" >&2; }
fail()  { printf "${RED}✖${RESET} %s\n" "$*" >&2; exit 1; }

prompt_yn() {
    local msg="$1" default="${2:-y}"
    local yn
    if [ "$default" = "y" ]; then
        printf "${BOLD}%s [Y/n]${RESET} " "$msg"
    else
        printf "${BOLD}%s [y/N]${RESET} " "$msg"
    fi
    read -r yn </dev/tty || yn=""
    yn="${yn:-$default}"
    case "$yn" in
        [Yy]*) return 0 ;;
        *) return 1 ;;
    esac
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ── Banner ────────────────────────────────────────────────────────────────────

banner() {
    printf "${CYAN}"
    cat <<'BANNER'

  ████████╗ █████╗ ██████╗ ██████╗ ██╗
  ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██║
     ██║   ███████║██████╔╝██████╔╝██║
     ██║   ██╔══██║██╔═══╝ ██╔═══╝ ██║
     ██║   ██║  ██║██║     ██║     ██║
     ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝     ╚═╝

BANNER
    printf "${RESET}"
    printf "  ${DIM}The fastest AI browser. Zero telemetry. Open source.${RESET}\n\n"
}

# ── OS Detection ──────────────────────────────────────────────────────────────

detect_os() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"
    DISTRO=""
    PKG_MGR=""

    case "$OS" in
        Darwin)
            OS="macos"
            ;;
        Linux)
            OS="linux"
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                DISTRO="${ID:-unknown}"
            fi
            # Detect package manager
            if command_exists apt-get; then
                PKG_MGR="apt"
            elif command_exists dnf; then
                PKG_MGR="dnf"
            elif command_exists yum; then
                PKG_MGR="yum"
            elif command_exists pacman; then
                PKG_MGR="pacman"
            elif command_exists zypper; then
                PKG_MGR="zypper"
            fi
            # WSL detection
            if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
                WSL=true
            else
                WSL=false
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            OS="windows"
            # Use %LOCALAPPDATA% as default on Windows (conventional location)
            if [ -n "${LOCALAPPDATA:-}" ]; then
                DEFAULT_INSTALL_DIR="$(cygpath -u "$LOCALAPPDATA")/tappi-browser"
            else
                DEFAULT_INSTALL_DIR="${HOME}/AppData/Local/tappi-browser"
            fi
            # Re-apply env override with new default
            INSTALL_DIR="${TAPPI_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
            ;;
        *)
            fail "Unsupported operating system: $OS"
            ;;
    esac

    info "Detected: ${BOLD}${OS}${RESET} (${ARCH})${DISTRO:+ — ${DISTRO}}"
}

# ── Dependency: Git ───────────────────────────────────────────────────────────

ensure_git() {
    if command_exists git; then
        ok "git $(git --version | awk '{print $3}')"
        return
    fi

    warn "git is not installed"
    if ! prompt_yn "Install git?"; then
        fail "git is required. Install it manually and re-run."
    fi

    case "$OS" in
        macos)
            info "Installing Xcode Command Line Tools (includes git)..."
            xcode-select --install 2>/dev/null || true
            printf "\n${YELLOW}A system dialog may have appeared. Complete the Xcode CLT installation, then re-run this script.${RESET}\n"
            exit 0
            ;;
        linux)
            install_linux_pkg git
            ;;
    esac

    command_exists git || fail "git installation failed"
    ok "git installed"
}

# ── Dependency: C++ Build Tools ───────────────────────────────────────────────

ensure_build_tools() {
    local have_tools=false

    case "$OS" in
        macos)
            if xcode-select -p >/dev/null 2>&1; then
                have_tools=true
            fi
            ;;
        linux)
            if command_exists g++ || command_exists c++; then
                have_tools=true
            fi
            ;;
        windows)
            # Check for Visual Studio Build Tools (cl.exe or VCToolsInstallDir)
            if command_exists cl || [ -n "${VCToolsInstallDir:-}" ]; then
                have_tools=true
            elif [ -d "/c/Program Files/Microsoft Visual Studio" ] || \
                 [ -d "/c/Program Files (x86)/Microsoft Visual Studio" ]; then
                have_tools=true
            fi
            ;;
    esac

    if $have_tools; then
        ok "C++ build tools"
        return
    fi

    warn "C++ build tools not found"

    case "$OS" in
        windows)
            printf "\n${YELLOW}Visual Studio Build Tools are required for native modules.${RESET}\n"
            printf "  1. Download from: ${CYAN}https://visualstudio.microsoft.com/visual-cpp-build-tools/${RESET}\n"
            printf "  2. Select ${BOLD}\"Desktop development with C++\"${RESET} workload\n"
            printf "  3. Install and re-run this script\n\n"
            if ! prompt_yn "Continue anyway? (build may fail without C++ tools)" "n"; then
                exit 1
            fi
            warn "Proceeding without confirmed build tools — npm install may fail"
            return
            ;;
        *)
            if ! prompt_yn "Install build tools?"; then
                fail "Build tools are required for native modules. Install manually and re-run."
            fi
            ;;
    esac

    case "$OS" in
        macos)
            info "Installing Xcode Command Line Tools..."
            xcode-select --install 2>/dev/null || true
            printf "\n${YELLOW}Complete the Xcode CLT installation dialog, then re-run this script.${RESET}\n"
            exit 0
            ;;
        linux)
            case "$PKG_MGR" in
                apt)    install_linux_pkg build-essential ;;
                dnf|yum) install_linux_pkg gcc-c++ make ;;
                pacman) install_linux_pkg base-devel ;;
                zypper) install_linux_pkg -t pattern devel_basis ;;
                *)      fail "Unknown package manager. Install g++ and make manually." ;;
            esac
            ;;
    esac

    ok "Build tools installed"
}

# ── Dependency: Node.js ───────────────────────────────────────────────────────

ensure_node() {
    # Source nvm if available (it may not be in PATH during curl|bash)
    load_nvm

    if command_exists node; then
        local node_version
        node_version="$(node -v | sed 's/^v//')"
        local node_major="${node_version%%.*}"

        if [ "$node_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
            ok "Node.js v${node_version}"
            return
        else
            warn "Node.js v${node_version} found, but v${MIN_NODE_MAJOR}+ is required"
        fi
    else
        warn "Node.js is not installed"
    fi

    if [ "$OS" = "windows" ]; then
        printf "\n${YELLOW}Node.js ${MIN_NODE_MAJOR}+ is required.${RESET}\n"
        printf "  Install from: ${CYAN}https://nodejs.org/${RESET}\n"
        printf "  Or via winget: ${DIM}winget install OpenJS.NodeJS.LTS${RESET}\n"
        printf "  Or via fnm:   ${DIM}winget install Schniz.fnm${RESET}\n\n"
        fail "Install Node.js and re-run this script."
    fi

    if ! prompt_yn "Install Node.js via nvm (recommended)?"; then
        fail "Node.js ${MIN_NODE_MAJOR}+ is required. Install manually and re-run."
    fi

    install_nvm_and_node
}

load_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        . "$NVM_DIR/nvm.sh"
    fi
}

install_nvm_and_node() {
    if [ ! -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        info "Installing nvm..."
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        . "$NVM_DIR/nvm.sh"
    fi

    info "Installing Node.js LTS via nvm..."
    nvm install --lts
    nvm use --lts
    ok "Node.js $(node -v) installed via nvm"
}

# ── Linux Package Install Helper ─────────────────────────────────────────────

install_linux_pkg() {
    info "Installing: $*"
    case "$PKG_MGR" in
        apt)
            sudo apt-get update -qq
            sudo apt-get install -y "$@"
            ;;
        dnf)
            sudo dnf install -y "$@"
            ;;
        yum)
            sudo yum install -y "$@"
            ;;
        pacman)
            sudo pacman -Sy --noconfirm "$@"
            ;;
        zypper)
            sudo zypper install -y "$@"
            ;;
        *)
            fail "No supported package manager found. Install '$*' manually."
            ;;
    esac
}

# ── Clone / Update Repository ────────────────────────────────────────────────

clone_or_update() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        info "Existing installation found — updating..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/main
        ok "Updated to latest"
    else
        info "Cloning Tappi Browser..."
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        ok "Cloned to $INSTALL_DIR"
    fi
}

# ── Build ─────────────────────────────────────────────────────────────────────

build_tappi() {
    cd "$INSTALL_DIR"

    info "Installing npm dependencies..."
    npm install --no-fund --no-audit 2>&1 | tail -1

    info "Rebuilding native modules for Electron..."
    npx electron-rebuild 2>&1 | tail -3

    info "Building Tappi..."
    npm run build 2>&1 | tail -1

    ok "Build complete"
}

# ── Desktop Integration: Linux ────────────────────────────────────────────────

integrate_linux() {
    # CLI wrapper
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/tappi" <<LAUNCHER
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec npx electron dist/main.js "\$@"
LAUNCHER
    chmod +x "$BIN_DIR/tappi"

    # .desktop file
    local app_dir="${HOME}/.local/share/applications"
    mkdir -p "$app_dir"
    cat > "$app_dir/tappi-browser.desktop" <<DESKTOP
[Desktop Entry]
Name=Tappi
Comment=AI-native browser with built-in agent
Exec=${BIN_DIR}/tappi %U
Icon=tappi-browser
Terminal=false
Type=Application
Categories=Network;WebBrowser;Productivity;
StartupWMClass=tappi
MimeType=x-scheme-handler/http;x-scheme-handler/https;
DESKTOP
    chmod +x "$app_dir/tappi-browser.desktop"

    # Icon
    local icon_src="$INSTALL_DIR/build/icons/256x256.png"
    if [ -f "$icon_src" ]; then
        local icon_dir="${HOME}/.local/share/icons/hicolor/256x256/apps"
        mkdir -p "$icon_dir"
        cp "$icon_src" "$icon_dir/tappi-browser.png"
    fi

    # Update desktop database if available
    if command_exists update-desktop-database; then
        update-desktop-database "$app_dir" 2>/dev/null || true
    fi

    ok "Linux desktop integration complete"
}

# ── Desktop Integration: macOS ────────────────────────────────────────────────

integrate_macos() {
    local app_dir="${HOME}/Applications/Tappi.app"
    local contents="$app_dir/Contents"
    local macos_dir="$contents/MacOS"
    local resources="$contents/Resources"

    mkdir -p "$macos_dir" "$resources"

    # Info.plist
    cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Tappi</string>
    <key>CFBundleDisplayName</key>
    <string>Tappi</string>
    <key>CFBundleIdentifier</key>
    <string>com.synthworx.tappi</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>tappi-launcher</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

    # Launcher script — sources nvm + Homebrew paths since Finder doesn't inherit shell env
    cat > "$macos_dir/tappi-launcher" <<LAUNCHER
#!/usr/bin/env bash

# Homebrew paths (Apple Silicon + Intel)
for p in /opt/homebrew/bin /usr/local/bin; do
    [ -d "\$p" ] && export PATH="\$p:\$PATH"
done

# Load nvm if installed
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ -s "\$NVM_DIR/nvm.sh" ]; then
    . "\$NVM_DIR/nvm.sh"
fi

cd "$INSTALL_DIR"
exec npx electron dist/main.js "\$@"
LAUNCHER
    chmod +x "$macos_dir/tappi-launcher"

    # Icon
    local icon_src="$INSTALL_DIR/build/icon.icns"
    if [ -f "$icon_src" ]; then
        cp "$icon_src" "$resources/icon.icns"
    fi

    # Touch to register with Launch Services
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -f "$app_dir" 2>/dev/null || true

    # CLI wrapper
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/tappi" <<LAUNCHER
#!/usr/bin/env bash

# Load nvm if installed
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ -s "\$NVM_DIR/nvm.sh" ]; then
    . "\$NVM_DIR/nvm.sh"
fi

cd "$INSTALL_DIR"
exec npx electron dist/main.js "\$@"
LAUNCHER
    chmod +x "$BIN_DIR/tappi"

    ok "macOS app bundle created at ~/Applications/Tappi.app"
}

# ── Desktop Integration: Windows ──────────────────────────────────────────────

integrate_windows() {
    local win_install_dir
    win_install_dir="$(cygpath -w "$INSTALL_DIR")"

    # tappi.cmd launcher in the install directory
    cat > "$INSTALL_DIR/tappi.cmd" <<CMD
@echo off
cd /d "${win_install_dir}"
npx electron dist\\main.js %*
CMD

    # Also create a bash wrapper for Git Bash users
    cat > "$INSTALL_DIR/tappi" <<LAUNCHER
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec npx electron dist/main.js "\$@"
LAUNCHER
    chmod +x "$INSTALL_DIR/tappi"

    # Start Menu shortcut via PowerShell
    local start_menu="${APPDATA:-$HOME/AppData/Roaming}/Microsoft/Windows/Start Menu/Programs"
    local win_start_menu
    win_start_menu="$(cygpath -w "$start_menu" 2>/dev/null || echo "$start_menu")"
    local win_icon="${win_install_dir}\\build\\icon.ico"

    info "Creating Start Menu shortcut..."
    powershell.exe -NoProfile -Command "
        \$ws = New-Object -ComObject WScript.Shell;
        \$sc = \$ws.CreateShortcut('${win_start_menu}\\Tappi.lnk');
        \$sc.TargetPath = 'cmd.exe';
        \$sc.Arguments = '/c \"\"${win_install_dir}\\tappi.cmd\"\"';
        \$sc.WorkingDirectory = '${win_install_dir}';
        \$sc.IconLocation = '${win_icon}';
        \$sc.Description = 'AI-native browser with built-in agent';
        \$sc.Save()
    " 2>/dev/null && ok "Start Menu shortcut created" || warn "Could not create Start Menu shortcut"

    # Set BIN_DIR to install dir for PATH check
    BIN_DIR="$INSTALL_DIR"

    ok "Windows integration complete"
}

# ── PATH Check ────────────────────────────────────────────────────────────────

ensure_path() {
    case ":$PATH:" in
        *":$BIN_DIR:"*) return ;;
    esac

    warn "$BIN_DIR is not in your PATH"

    if [ "$OS" = "windows" ]; then
        local win_bin_dir
        win_bin_dir="$(cygpath -w "$BIN_DIR")"
        if prompt_yn "Add install directory to your Windows user PATH?"; then
            powershell.exe -NoProfile -Command "
                \$current = [Environment]::GetEnvironmentVariable('PATH', 'User');
                if (\$current -notlike '*${win_bin_dir}*') {
                    [Environment]::SetEnvironmentVariable('PATH', \$current + ';${win_bin_dir}', 'User')
                }
            " 2>/dev/null && ok "Added to user PATH — restart your terminal for changes to take effect" \
                          || warn "Could not modify PATH. Add this directory manually: $win_bin_dir"
        else
            warn "Add this to your PATH manually:"
            printf '  %s\n' "$win_bin_dir"
        fi
        return
    fi

    local shell_rc=""
    case "${SHELL:-/bin/bash}" in
        */zsh)  shell_rc="$HOME/.zshrc" ;;
        */bash) shell_rc="$HOME/.bashrc" ;;
        */fish) shell_rc="$HOME/.config/fish/config.fish" ;;
        *)      shell_rc="$HOME/.profile" ;;
    esac

    if prompt_yn "Add $BIN_DIR to PATH in $shell_rc?"; then
        printf '\n# Tappi Browser\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$shell_rc"
        ok "Added to $shell_rc — restart your shell or run: source $shell_rc"
    else
        warn "Add this to your shell config manually:"
        printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    fi
}

# ── Uninstall Hint ────────────────────────────────────────────────────────────

print_uninstall_hint() {
    printf "\n${DIM}To uninstall:${RESET}\n"
    case "$OS" in
        windows)
            local win_dir
            win_dir="$(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")"
            printf "  ${DIM}rmdir /s /q \"%s\"${RESET}\n" "$win_dir"
            printf "  ${DIM}del \"%%APPDATA%%\\Microsoft\\Windows\\Start Menu\\Programs\\Tappi.lnk\"${RESET}\n"
            ;;
        *)
            printf "  ${DIM}rm -rf %s${RESET}\n" "$INSTALL_DIR"
            printf "  ${DIM}rm -f %s/tappi${RESET}\n" "$BIN_DIR"
            case "$OS" in
                linux)
                    printf "  ${DIM}rm -f ~/.local/share/applications/tappi-browser.desktop${RESET}\n"
                    printf "  ${DIM}rm -f ~/.local/share/icons/hicolor/256x256/apps/tappi-browser.png${RESET}\n"
                    ;;
                macos)
                    printf "  ${DIM}rm -rf ~/Applications/Tappi.app${RESET}\n"
                    ;;
            esac
            ;;
    esac
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
    banner
    detect_os

    printf "\n${BOLD}This will install Tappi Browser to:${RESET}\n"
    printf "  ${CYAN}%s${RESET}\n\n" "$INSTALL_DIR"

    if ! prompt_yn "Continue?"; then
        printf "Aborted.\n"
        exit 0
    fi

    printf "\n"

    # Dependencies
    ensure_git
    ensure_build_tools
    ensure_node

    printf "\n"

    # Clone / update
    clone_or_update

    # Build
    build_tappi

    printf "\n"

    # Platform integration
    case "$OS" in
        linux)   integrate_linux ;;
        macos)   integrate_macos ;;
        windows) integrate_windows ;;
    esac

    # PATH
    ensure_path

    # Done
    printf "\n${GREEN}${BOLD}Tappi Browser installed successfully!${RESET}\n\n"
    case "$OS" in
        windows)
            printf "  Launch:  ${CYAN}tappi.cmd${RESET}  (from cmd.exe)\n"
            printf "  Launch:  ${CYAN}tappi${RESET}      (from Git Bash)\n"
            printf "  Or find ${BOLD}Tappi${RESET} in the Start Menu\n"
            ;;
        linux)
            printf "  Launch:  ${CYAN}tappi${RESET}\n"
            printf "  Or find ${BOLD}Tappi${RESET} in your application menu\n"
            ;;
        macos)
            printf "  Launch:  ${CYAN}tappi${RESET}\n"
            printf "  Or open ${BOLD}~/Applications/Tappi.app${RESET} from Finder / Spotlight\n"
            ;;
    esac

    print_uninstall_hint
    printf "\n"
}

main "$@"
