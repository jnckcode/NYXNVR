@echo off
setlocal enabledelayedexpansion

echo ================================================================
echo    NYX NVR - AUTOMATED INSTALLER & SETUP
echo ================================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js v18 or higher from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js detected:
node -v

:: 2. Check FFmpeg
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [WARNING] FFmpeg was not detected in system PATH!
    echo NYX NVR requires FFmpeg for RTSP camera ingestion and recording.
    echo Please download FFmpeg from https://gyan.dev/ffmpeg/builds/ and add the 'bin' folder to system PATH.
    echo.
) else (
    echo [OK] FFmpeg detected in system PATH.
)

:: 3. Create Storage and Data Directories
echo.
echo [1/4] Ensuring required storage directories exist...
if not exist "storage\recordings" mkdir "storage\recordings"
if not exist "storage\snapshots" mkdir "storage\snapshots"
if not exist "models" mkdir "models"
if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"
echo [OK] Storage directories ready.

:: 4. Install Dependencies
echo.
echo [2/4] Installing NPM dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install encountered errors!
    pause
    exit /b 1
)

:: 5. Build Project
echo.
echo [3/4] Building production assets (TypeScript ^& Web UI)...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

:: 6. Service Installation Prompt
echo.
echo [4/4] Installation complete!
echo ================================================================
echo Do you want to register NYX NVR as an automatic Windows Background Service?
echo (It will start automatically when Windows boots up without any console window)
echo ================================================================
set /p INSTALL_SERVICE="Install as Background Service? (Y/N, default Y): "
if /i "!INSTALL_SERVICE!"=="" set INSTALL_SERVICE=Y
if /i "!INSTALL_SERVICE!"=="Y" (
    echo.
    echo Registering Windows Background Service...
    node scripts\service-manager.js install
) else (
    echo.
    echo Skipping service installation.
    echo You can start NYX NVR manually at any time by running:
    echo    npm start
    echo or start in background via:
    echo    npm run service:install
)

echo.
echo ================================================================
echo    NYX NVR SETUP FINISHED SUCCESSFULLY!
echo ================================================================
echo.
pause
