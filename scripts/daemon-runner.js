/**
 * @file daemon-runner.js
 * @description Supervisor daemon that spawns and monitors the NYX NVR server process, auto-restarting on unexpected crashes with log rotation.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'dist', 'index.js');
const logsDir = path.join(projectRoot, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const serviceLogPath = path.join(logsDir, 'service.log');
const pidFilePath = path.join(projectRoot, '.daemon_pid');

fs.writeFileSync(pidFilePath, String(process.pid), 'utf-8');

function log(msg) {
  const line = `[${new Date().toISOString()}] [Supervisor] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(serviceLogPath, line);
  } catch {}
}

log(`Supervisor started with PID ${process.pid}. Target: ${entryPoint}`);

let child = null;
let isShuttingDown = false;
let restartCount = 0;
let lastRestartTime = Date.now();

function startChild() {
  if (isShuttingDown) return;

  log(`Spawning NYX NVR child process...`);
  const logStream = fs.createWriteStream(serviceLogPath, { flags: 'a' });

  child = spawn(process.execPath, ['--max-old-space-size=256', entryPoint], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on('exit', (code, signal) => {
    log(`Child process exited with code ${code}, signal: ${signal || 'none'}`);
    child = null;

    if (isShuttingDown) {
      log('Supervisor exiting due to shutdown signal.');
      process.exit(0);
      return;
    }

    const now = Date.now();
    if (now - lastRestartTime > 60000) {
      restartCount = 0; // reset counter after 1 min of stable run
    }
    lastRestartTime = now;
    restartCount++;

    const delay = Math.min(1000 * Math.pow(1.5, restartCount), 30000);
    log(`Restarting child process in ${Math.round(delay / 1000)}s (crash count: ${restartCount})...`);
    setTimeout(startChild, delay);
  });
}

function handleShutdown(sig) {
  log(`Received ${sig}. Terminating child process gracefully...`);
  isShuttingDown = true;
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch {}

  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

startChild();
