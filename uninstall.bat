@echo off
setlocal enabledelayedexpansion

echo ================================================================
echo    NYX NVR - UNINSTALLER & SERVICE REMOVAL
echo ================================================================
echo.

:: 1. Stop and remove background service
echo [1/3] Stopping active background service if running...
node scripts\service-manager.js stop

echo.
echo [2/3] Unregistering Windows background service...
node scripts\service-manager.js uninstall

:: 2. Cleanup confirmation
echo.
echo [3/3] Service removed.
echo ================================================================
echo Do you want to delete stored video recordings and databases?
echo (WARNING: Selecting Y will PERMANENTLY delete all recordings and snapshots!)
echo ================================================================
set /p PURGE_DATA="Permanently delete storage & database? (Y/N, default N): "
if /i "!PURGE_DATA!"=="Y" (
    echo.
    echo Purging storage and data folders...
    if exist "data" rmdir /s /q "data"
    if exist "storage\recordings" rmdir /s /q "storage\recordings"
    if exist "storage\snapshots" rmdir /s /q "storage\snapshots"
    if exist "logs" rmdir /s /q "logs"
    if exist ".daemon_pid" del /f /q ".daemon_pid"
    if exist ".runtime_port" del /f /q ".runtime_port"
    echo [OK] Storage and data purged.
) else (
    echo.
    echo Keeping your footage, database, and snapshots intact.
)

echo.
echo ================================================================
echo    NYX NVR HAS BEEN UNINSTALLED FROM SERVICES.
echo ================================================================
echo.
pause
