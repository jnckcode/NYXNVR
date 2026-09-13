#!/usr/bin/env bash
# ==============================================================================
# NYX NVR - Linux / STB Automated Uninstaller
# ==============================================================================
set -e

echo "================================================================"
echo "   NYX NVR - LINUX UNINSTALLER & SERVICE REMOVAL"
echo "================================================================"
echo ""

if [ "$EUID" -ne 0 ]; then
    echo "Notice: Root privileges required to stop and remove systemd service."
    echo "Running with sudo..."
    sudo node scripts/service-manager.js stop
    sudo node scripts/service-manager.js uninstall
else
    node scripts/service-manager.js stop
    node scripts/service-manager.js uninstall
fi

echo ""
echo "Service successfully uninstalled."
read -p "Do you want to permanently delete recorded footage and databases? (y/N): " purge_choice
if [[ "$purge_choice" =~ ^[Yy]$ ]]; then
    rm -rf data storage/recordings storage/snapshots logs .daemon_pid .runtime_port
    echo "[OK] Storage & database directories cleaned."
else
    echo "Your recordings and database files were preserved."
fi

echo ""
echo "================================================================"
echo "   NYX NVR UNINSTALLATION COMPLETED."
echo "================================================================"
