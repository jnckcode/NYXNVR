# 🛡️ NYX NVR (Antigravity Network Video Recorder)

> **Next-Generation Edge CCTV & AI Surveillance Platform**  
> *Engineered for ultra-low latency, single-ingestion camera streams, zero-config UX, and resource-constrained edge hardware (ARM64 STB HG680-P 2GB RAM, Raspberry Pi, Mini PC, Windows & Linux Servers).*

---

## 📋 Table of Contents
- [Architecture Overview](#-architecture-overview)
- [Key Features](#-key-features)
- [System Requirements](#-system-requirements)
- [Quick Start](#-quick-start)
- [Automated Installation](#-automated-installation)
- [Background Service Management](#-background-service-management)
- [Automatic Port Conflict Detection](#-automatic-port-conflict-detection)
- [Storage & Auto-Delete Retention Engine](#-storage--auto-delete-retention-engine)
- [REST API & WebSocket Specification](#-rest-api--websocket-specification)
- [Uninstallation](#-uninstallation)
- [License](#-license)

---

## 🏗️ Architecture Overview

NYX NVR is built from the ground up to solve the high-CPU and high-RAM bottlenecks of traditional NVRs. By implementing **Single Ingestion**, every camera RTSP stream is ingested **only once** by FFmpeg and demuxed concurrently into three lightweight outputs:

```mermaid
flowchart TD
    CAM["IP Camera (RTSP)"] -->|Single Ingestion| FFMPEG["FFmpeg Process"]
    
    FFMPEG -->|Pipe 1: fMP4 Frag| WS["WebSocket Server (/ws/live/:id)"]
    FFMPEG -->|Pipe 2: MP4 Copy| DISK["Local Storage (/storage/recordings)"]
    FFMPEG -->|Pipe 3: RGB 5fps| FILTER["Stage 1: MotionFilter (Pixel Diff)"]
    
    WS -->|MSE Chunk Streaming| BROWSER["Browser HTML5 MSE Player (<500ms)"]
    
    FILTER -->|Motion Score > Threshold| AI["Stage 2: AI Analytics Worker (YOLOv8 ONNX)"]
    FILTER -.->|No Motion (Quiet)| SKIP["Bypass AI Inference (0% CPU)"]
    
    AI -->|Object Detected in ROI| EVT["Event Storage (SQLite WAL) & Snapshot"]
    EVT -->|Notification| BROWSER
    
    RETENTION["RetentionWorker Engine"] -->|Hourly / On-Demand Purge| PURGE["Auto Delete Expired Recordings & Snapshots"]
```

---

## ⚡ Key Features

- **🚀 Ultra-Low Latency HTML5 Player (<500ms):**
  Uses fragmented MP4 (fMP4) piped over WebSockets directly into browser MediaSource Extensions (MSE). No WebRTC complexity (no STUN/TURN), no HLS latency chunks.
- **🧠 Two-Stage AI Analytics Engine:**
  - **Stage 1 (Pre-filter):** Fast native pixel-difference motion detection (160x120 grayscale) consumes virtually 0% CPU when scenes are static.
  - **Stage 2 (Inference):** Spawns dedicated worker threads with ONNX Runtime running YOLOv8n only when motion is detected.
  - **Custom Polygonal ROI Masks:** Set trigger zones directly in the UI to prevent false alarms from public roads or tree branches.
  - **Hot-Reloadable Models:** Upload custom `.onnx` models from the dashboard without restarting the server.
- **🔌 Automatic Port Conflict Discovery:**
  If the default port `3000` is already in use by another application, NYX NVR automatically scans and binds to the next available port (`3001`, `3002`, etc.) without crashing.
- **⏱️ Time-Based Auto-Delete & Retention Engine:**
  - Configurable retention in **Hours** or **Days** (e.g. 6h, 12h, 24h, 3d, 7d, 14d, 30d, or custom).
  - Optional auto-purge for expired AI detection event snapshots (`.jpg`) and database records.
  - Emergency disk threshold guard (automatically clears oldest recordings if storage reaches 90%).
  - On-demand manual purge action ("Purge Expired Now") via API & dashboard.
- **🎨 Industrial Brutalist UX:**
  Clean, high-contrast hazard-amber aesthetic optimized for security control rooms. Flexible 1x1, 2x2, 3x3, 4x4 camera grids with single-click fullscreen focus.
- **📡 Auto Camera Discovery:**
  Built-in ONVIF and SSDP probes automatically scan the local subnet to detect IP cameras with 1-click addition.
- **🗄️ SQLite WAL High-Concurrency Storage:**
  ACID-compliant SQLite with Write-Ahead Logging (WAL) ensures zero read/write blocking between video indexing and UI telemetry.

---

## 💻 System Requirements

| Component | Minimum Specification | Recommended Specification |
|---|---|---|
| **Hardware** | ARM64 Quad-Core / x86_64 Dual-Core | ARM64 8-Core / Intel Celeron N5105 / Core i3 |
| **RAM** | 2 GB (e.g., STB HG680-P) | 4 GB - 8 GB |
| **Storage** | 16 GB eMMC / MicroSD | 128 GB+ NVMe SSD / SATA HDD |
| **OS** | Windows 10/11, Ubuntu 20.04+, Debian/Armbian | Windows Server, Debian 12 / Armbian Bullseye |
| **Node.js** | v18.0.0 or higher | v20.x or v22.x LTS |
| **FFmpeg** | v4.4 or higher | v6.x or higher with hardware acceleration |

---

## 🚀 Quick Start

### 1. Clone or Download Repository
```bash
cd /path/to/NYXNVR
```

### 2. Manual Development Run
```bash
# Install dependencies
npm install

# Compile TypeScript & Frontend assets
npm run build

# Start in development mode
npm start
```
Open your browser and navigate to:
```
http://localhost:3000
```
*(If port 3000 is occupied, check console output for the automatically assigned port!)*

---

## 🛠️ Automated Installation

NYX NVR comes equipped with automated one-click installer scripts for both Windows and Linux environments.

### 🪟 Windows Installation
Double-click `install.bat` or run via Command Prompt / PowerShell:
```cmd
install.bat
```
**What the installer does:**
1. Checks Node.js & FFmpeg presence in system `PATH`.
2. Creates storage directories (`storage/recordings`, `storage/snapshots`, `models`, `data`, `logs`).
3. Runs `npm install` and compiles the TypeScript project (`npm run build`).
4. Prompts to install and start NYX NVR as an automatic **Windows Background Service** (starts on boot).

---

### 🐧 Linux / ARM64 STB Installation
Run the installer shell script:
```bash
chmod +x install.sh
sudo ./install.sh
```
**What the installer does:**
1. Validates Node.js and FFmpeg installations.
2. Creates required storage folders.
3. Installs NPM packages and builds production bundles.
4. Generates and registers `/etc/systemd/system/nyxnvr.service`, enables it on boot, and starts it.

---

## ⚙️ Background Service Management

NYX NVR includes a cross-platform service manager that supervises the process, auto-restarts the server if an unexpected crash occurs, and logs all outputs to `logs/service.log`.

### CLI Commands (npm scripts)

| Command | Action |
|---|---|
| `npm run service:install` | Registers NYX NVR as a persistent system background service |
| `npm run service:start` | Starts the background daemon |
| `npm run service:stop` | Gracefully stops the running background service |
| `npm run service:status` | Displays service state (RUNNING / STOPPED), PID, and active port |
| `npm run service:uninstall` | Unregisters and completely removes the service |

### Manual Execution with Node.js
```bash
# Check status
node scripts/service-manager.js status

# Start service
node scripts/service-manager.js start

# Stop service
node scripts/service-manager.js stop

# Install / Uninstall
node scripts/service-manager.js install
node scripts/service-manager.js uninstall
```

---

## 🔍 Automatic Port Conflict Detection

If port `3000` is already taken by another development server, Nginx, Docker, or another application, NYX NVR does **not** crash with `EADDRINUSE`.

Instead, the **PortFinder** engine intercepts the startup cycle:
```
[INFO] 4. Starting Fastify Web & WebSocket Server (desired port: 3000)...
[WARN] [PortFinder] [PORT CONFLICT] Desired port 3000 is already occupied by another service.
[INFO] [PortFinder] Automatically scanning for the next available port starting from 3001...
[INFO] [PortFinder] [PORT ACQUIRED] Auto-selected available port: 3001
[INFO] Antigravity NVR Web Server listening at http://localhost:3001
====================================================
   Antigravity NVR IS RUNNING AND READY!
   Web Dashboard: http://localhost:3001 (auto-shifted from 3000)
====================================================
```

### Custom Port Specification
To force a specific port, set the `PORT` environment variable:
```bash
# Windows PowerShell
$env:PORT="8080"; npm start

# Linux / macOS
PORT=8080 npm start
```
The active port is always saved to `.runtime_port` for external monitoring scripts.

---

## ⏱️ Storage & Auto-Delete Retention Engine

The retention worker operates every 5 minutes and supports both time-based expiration and emergency disk conservation.

### How It Works:
1. **Time-Based Expiration:**
   - Evaluates all indexed recordings against the cutoff: `now - retention_hours`.
   - Safely removes the `.mp4` video files from the storage drive and deletes the SQLite index row.
   - Cleans up any un-indexed orphan `.mp4` files older than the cutoff.
2. **AI Snapshot Auto-Purge:**
   - If enabled (`auto_delete_snapshots: 1`), detection event snapshots (`.jpg`) older than the retention cutoff are removed, freeing significant disk space.
3. **Emergency Disk Guard:**
   - If drive capacity exceeds `disk_threshold_percent` (default: 90%), the oldest recordings are continuously purged until capacity falls below the threshold.
4. **Manual Purge Action:**
   - Execute immediate purge from the dashboard UI or via `POST /api/v1/storage/purge`.

---

## 📡 REST API & WebSocket Specification

### 📹 Camera Management
- `GET /api/v1/cameras` — List all registered cameras.
- `POST /api/v1/cameras` — Add a new camera (`name`, `rtsp_url`, `sub_stream_url`, `is_enabled`, `ai_enabled`).
- `PUT /api/v1/cameras/:id` — Update camera parameters.
- `DELETE /api/v1/cameras/:id` — Remove a camera and stop active ingestion.
- `PATCH /api/v1/cameras/:id/ai` — Toggle AI object detection for a camera.
- `PUT /api/v1/cameras/:id/roi` — Save normalized polygon points for AI region-of-interest mask.

### 🎥 Live Video & WebSocket
- `GET /ws/live/:id` (WebSocket) — Connect to live camera feed. Receives binary fragmented MP4 chunks.
- `GET /ws/events` (WebSocket) — Real-time stream of AI detection events and system alerts.

### 📼 Recordings & Playback
- `GET /api/v1/recordings` — Query recordings with filters (`cameraId`, `date`, `limit`, `offset`).
- `GET /api/v1/recordings/:id/stream` — Stream/download an MP4 segment.

### 🚨 AI Events
- `GET /api/v1/events` — Query AI events with pagination, label filter, and date filters.
- `GET /api/v1/events/:id/snapshot` — View the high-resolution event snapshot.

### 💾 Storage & Retention
- `GET /api/v1/storage/retention-status` — Get retention policy, oldest recording, and last purge metrics.
- `POST /api/v1/storage/purge` — Trigger immediate cleanup of expired recordings and snapshots.
- `GET /api/v1/system/disk` — Disk space telemetry (total, free, used).

### ⚙️ System Settings & AI Models
- `GET /api/v1/settings` — Get current system settings map.
- `PUT /api/v1/settings` — Update dynamic settings (retention hours, AI thresholds, target classes).
- `POST /api/v1/models/upload` — Upload and hot-reload a custom `.onnx` YOLO model.
- `GET /api/v1/system/metrics` — Real-time CPU, RAM, and active stream telemetry.

---

## 🗑️ Uninstallation

### 🪟 Windows
Run `uninstall.bat`:
```cmd
uninstall.bat
```
The uninstaller will:
1. Terminate running background daemon processes.
2. Remove the Windows Startup / Task Scheduler service.
3. Prompt whether you want to preserve or permanently delete stored recordings, snapshots, and databases.

### 🐧 Linux
Run `uninstall.sh`:
```bash
sudo ./uninstall.sh
```
Stops and disables the `nyxnvr.service` systemd unit, removes the service file, and reloads systemd.

---

## 📄 License
MIT License © 2026 NYX NVR & Antigravity Engineering. Built with high performance, edge resilience, and privacy in mind.
