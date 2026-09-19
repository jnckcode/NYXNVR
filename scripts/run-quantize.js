/**
 * @file run-quantize.js
 * @description Cross-platform Python execution wrapper for YOLOv8 INT8 quantization.
 * Automatically resolves the working Python interpreter across Windows, Linux, and macOS.
 */

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const scriptPath = path.resolve(__dirname, 'quantize.py');
const extraArgs = process.argv.slice(2);

function findPythonCommand() {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        { cmd: 'py', args: ['-3'] },
        { cmd: 'python', args: [] },
        { cmd: 'python3', args: [] }
      ]
    : [
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] }
      ];

  for (const candidate of candidates) {
    try {
      const test = spawnSync(candidate.cmd, [...candidate.args, '--version'], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      if (test.status === 0 && !test.error) {
        return candidate;
      }
    } catch {
      // Continue searching
    }
  }
  return null;
}

const pythonCandidate = findPythonCommand();

if (!pythonCandidate) {
  console.error('\n[ERROR] No working Python 3 installation found in PATH.');
  console.error('Please install Python 3 (https://www.python.org/) and install required packages:');
  console.error('   pip install onnx onnxruntime\n');
  process.exit(1);
}

const runArgs = [...pythonCandidate.args, scriptPath, ...extraArgs];
const child = spawn(pythonCandidate.cmd, runArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
