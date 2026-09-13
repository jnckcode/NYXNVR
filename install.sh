#!/usr/bin/env bash
# ==============================================================================
# NYX NVR - Linux / STB Automated Installer
# ==============================================================================
set -e

echo "================================================================"
echo "   NYX NVR - LINUX / ARM64 AUTOMATED INSTALLER"
echo "================================================================"
echo ""

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed. Please install Node.js v18 or newer."
    exit 1
fi
echo "[OK] Node.js $(node -v) detected."

# 2. Check FFmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[WARNING] FFmpeg is not installed."
    echo "Install via: sudo apt-get update && sudo apt-get install -y ffmpeg"
else
    echo "[OK] FFmpeg $(ffmpeg -version | head -n 1) detected."
fi

# 3. Create Storage Folders
mkdir -p storage/recordings storage/snapshots models data logs

# 4. Install NPM packages & Build
echo ""
echo "[1/3] Installing NPM dependencies..."
npm install

echo ""
echo "[2/3] Building TypeScript & Web UI..."
npm run build

# 5. Service setup
echo ""
echo "[3/3] Setting up systemd background service..."
if [ "$EUID" -ne 0 ]; then
    echo "Notice: Systemd service installation requires root privileges."
    echo "Run: sudo node scripts/service-manager.js install"
else
    node scripts/service-manager.js install
fi

echo ""
echo "================================================================"
echo "   NYX NVR INSTALLATION COMPLETED!"
echo "================================================================"
