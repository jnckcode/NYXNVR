/**
 * @file service-manager.js
 * @description Cross-platform background service installer & lifecycle manager (Windows Task Scheduler / Service & Linux systemd).
 * @commands install, uninstall, start, stop, status
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const TASK_NAME = 'NYXNVR';
const SERVICE_NAME = 'nyxnvr';
const pidFilePath = path.join(projectRoot, '.daemon_pid');
const runtimePortFilePath = path.join(projectRoot, '.runtime_port');

const action = (process.argv[2] || 'status').toLowerCase();

function printBanner() {
  console.log('\n======================================================');
  console.log('   NYX NVR - SYSTEM SERVICE MANAGER');
  console.log(`   OS: ${process.platform.toUpperCase()} (${os.arch()}) | Action: ${action.toUpperCase()}`);
  console.log('======================================================\n');
}

function ensureBuild() {
  const distIndex = path.join(projectRoot, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    console.log('[1/2] Production build not found. Running `npm run build`...');
    execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    console.log('[2/2] Build completed successfully.');
  }
}

// -----------------------------------------------------------------------------
// WINDOWS SERVICE IMPLEMENTATION (Task Scheduler / Background Daemon)
// -----------------------------------------------------------------------------
const WindowsService = {
  install() {
    ensureBuild();
    console.log(`[Windows] Registering automated startup service "${TASK_NAME}"...`);

    const vbsPath = path.join(projectRoot, 'scripts', 'start-hidden.vbs');
    const runnerPath = path.join(projectRoot, 'scripts', 'daemon-runner.js');

    // Create Scheduled Task to run silently on boot / logon with Highest privileges
    try {
      const taskCmd = `schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${vbsPath}\\"" /SC ONSTART /RU "SYSTEM" /RL HIGHEST /F`;
      execSync(taskCmd, { stdio: 'pipe' });
      console.log(`[SUCCESS] Registered Windows System Service task "${TASK_NAME}" (Runs on System Boot).`);
    } catch (e) {
      // If SYSTEM fails (e.g. non-admin shell), register for current user on logon
      console.log('[WARN] Administrator privilege needed for ONSTART SYSTEM task. Falling back to User Logon task...');
      const fallbackCmd = `schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${vbsPath}\\"" /SC ONLOGON /RL HIGHEST /F`;
      try {
        execSync(fallbackCmd, { stdio: 'pipe' });
        console.log(`[SUCCESS] Registered Windows User Service task "${TASK_NAME}" (Runs on User Logon).`);
      } catch (err2) {
        console.error('[ERROR] Failed to register task with schtasks:', err2.message);
        process.exit(1);
      }
    }

    console.log('\nStarting service now...');
    this.start();
  },

  uninstall() {
    console.log(`[Windows] Unregistering service "${TASK_NAME}"...`);
    this.stop();

    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
      console.log(`[SUCCESS] Windows Service task "${TASK_NAME}" removed.`);
    } catch (e) {
      console.log(`[INFO] No scheduled task named "${TASK_NAME}" found.`);
    }
  },

  start() {
    if (this.isRunning()) {
      console.log('[INFO] NYX NVR service is already running.');
      this.status();
      return;
    }

    console.log('[Windows] Launching background daemon...');
    const vbsPath = path.join(projectRoot, 'scripts', 'start-hidden.vbs');
    execSync(`wscript.exe "${vbsPath}"`, { cwd: projectRoot, stdio: 'ignore' });

    // Wait 2 seconds and verify status
    setTimeout(() => {
      this.status();
    }, 2000);
  },

  stop() {
    console.log('[Windows] Stopping NYX NVR daemon and child processes...');
    let stopped = false;

    if (fs.existsSync(pidFilePath)) {
      try {
        const pid = fs.readFileSync(pidFilePath, 'utf-8').trim();
        if (pid) {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
          console.log(`[SUCCESS] Terminated PID ${pid} and sub-processes.`);
          stopped = true;
        }
      } catch (e) {}
      try { fs.unlinkSync(pidFilePath); } catch {}
    }

    // Terminate any lingering instances of daemon-runner or dist/index
    try {
      const wmic = execSync('wmic process where "commandline like \'%dist\\\\index.js%\' or commandline like \'%daemon-runner.js%\'" get processid', { encoding: 'utf-8' });
      const pids = wmic.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l));
      for (const p of pids) {
        try { execSync(`taskkill /PID ${p} /T /F`, { stdio: 'pipe' }); stopped = true; } catch {}
      }
    } catch {}

    if (stopped) {
      console.log('[SUCCESS] All NYX NVR service instances have been stopped.');
    } else {
      console.log('[INFO] No active NYX NVR service was running.');
    }
  },

  isRunning() {
    if (fs.existsSync(pidFilePath)) {
      try {
        const pid = fs.readFileSync(pidFilePath, 'utf-8').trim();
        if (pid && /^\d+$/.test(pid)) {
          const res = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf-8' });
          if (res.includes(pid)) {
            return true;
          }
        }
      } catch (err) {}

      // Stale PID file, clean it up
      try { fs.unlinkSync(pidFilePath); } catch {}
    }
    return false;
  },

  status() {
    const running = this.isRunning();
    let port = '3000';
    if (fs.existsSync(runtimePortFilePath)) {
      port = fs.readFileSync(runtimePortFilePath, 'utf-8').trim() || '3000';
    }

    console.log('------------------------------------------------------');
    console.log(`Service Name : ${TASK_NAME}`);
    console.log(`Status       : ${running ? '🟢 RUNNING (Active in background)' : '⚪ STOPPED'}`);
    if (running) {
      let pid = 'Unknown';
      if (fs.existsSync(pidFilePath)) {
        pid = fs.readFileSync(pidFilePath, 'utf-8').trim();
      }
      console.log(`PID          : ${pid}`);
      console.log(`Dashboard URL: http://localhost:${port}`);
      console.log(`Log File     : ${path.join(projectRoot, 'logs', 'service.log')}`);
    }
    console.log('------------------------------------------------------');
  }
};

// -----------------------------------------------------------------------------
// LINUX SYSTEMD SERVICE IMPLEMENTATION
// -----------------------------------------------------------------------------
const LinuxService = {
  serviceFile: `/etc/systemd/system/${SERVICE_NAME}.service`,

  install() {
    ensureBuild();
    console.log(`[Linux] Generating systemd unit file at ${this.serviceFile}...`);
    const nodeBin = process.execPath;
    const runner = path.join(projectRoot, 'scripts', 'daemon-runner.js');

    const unit = `[Unit]
Description=NYX NVR - Lightweight Edge Video Recorder Service
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER || 'root'}
WorkingDirectory=${projectRoot}
ExecStart=${nodeBin} ${runner}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

    try {
      fs.writeFileSync(this.serviceFile, unit, 'utf-8');
      execSync('systemctl daemon-reload', { stdio: 'inherit' });
      execSync(`systemctl enable ${SERVICE_NAME}`, { stdio: 'inherit' });
      execSync(`systemctl start ${SERVICE_NAME}`, { stdio: 'inherit' });
      console.log(`[SUCCESS] systemd service "${SERVICE_NAME}" installed, enabled, and started.`);
      this.status();
    } catch (e) {
      console.error('[ERROR] Failed to write systemd unit file. Make sure to run with sudo:', e.message);
      process.exit(1);
    }
  },

  uninstall() {
    console.log(`[Linux] Removing systemd service "${SERVICE_NAME}"...`);
    try {
      execSync(`systemctl stop ${SERVICE_NAME}`, { stdio: 'pipe' });
      execSync(`systemctl disable ${SERVICE_NAME}`, { stdio: 'pipe' });
    } catch {}

    if (fs.existsSync(this.serviceFile)) {
      fs.unlinkSync(this.serviceFile);
      execSync('systemctl daemon-reload', { stdio: 'inherit' });
      console.log(`[SUCCESS] Removed ${this.serviceFile}.`);
    } else {
      console.log('[INFO] Service file was not found.');
    }
  },

  start() {
    console.log(`[Linux] Starting systemd service "${SERVICE_NAME}"...`);
    execSync(`systemctl start ${SERVICE_NAME}`, { stdio: 'inherit' });
    this.status();
  },

  stop() {
    console.log(`[Linux] Stopping systemd service "${SERVICE_NAME}"...`);
    execSync(`systemctl stop ${SERVICE_NAME}`, { stdio: 'inherit' });
    this.status();
  },

  status() {
    try {
      execSync(`systemctl status ${SERVICE_NAME}`, { stdio: 'inherit' });
    } catch (e) {
      console.log(`[INFO] Service is not active or not installed.`);
    }
  }
};

printBanner();

const targetService = isWindows ? WindowsService : isLinux ? LinuxService : null;

if (!targetService) {
  console.error(`[ERROR] Unsupported operating system: ${process.platform}`);
  process.exit(1);
}

switch (action) {
  case 'install':
    targetService.install();
    break;
  case 'uninstall':
    targetService.uninstall();
    break;
  case 'start':
    targetService.start();
    break;
  case 'stop':
    targetService.stop();
    break;
  case 'status':
    targetService.status();
    break;
  default:
    console.log('Usage: node scripts/service-manager.js <install|uninstall|start|stop|status>');
    process.exit(1);
}
