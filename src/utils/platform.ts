/**
 * @file platform.ts
 * @description OS Environment and Hardware/FFmpeg Capability Detector.
 * Automatically adapts runtime parameters across Windows, Linux, Armbian/Debian (ARM STB/SBC), and macOS
 * to prevent CLI argument misconfigurations and performance bottlenecks.
 * 
 * @functions getPlatformInfo, getFfmpegCapabilities, buildFfmpegRtspInputArgs
 * @dependencies child_process, fs, os, utils/logger
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { createLogger } from './logger';

const logger = createLogger('PlatformDetector');

export interface PlatformInfo {
  os: 'windows' | 'linux' | 'darwin' | 'unknown';
  platform: string;
  arch: string;
  isWindows: boolean;
  isLinux: boolean;
  isMacOS: boolean;
  isArm: boolean;
  isArmbian: boolean;
  distro: string;
  cpuCores: number;
}

export interface FfmpegCapabilities {
  available: boolean;
  version: string;
  rtspTimeoutFlag: '-timeout' | '-stimeout';
  supportsNobuffer: boolean;
  supportsLowDelay: boolean;
  optimalThreads: number;
}

let cachedPlatformInfo: PlatformInfo | null = null;
let cachedFfmpegCaps: FfmpegCapabilities | null = null;

/**
 * Detects operating system, Linux distribution, and hardware architecture.
 */
export function getPlatformInfo(): PlatformInfo {
  if (cachedPlatformInfo) {
    return cachedPlatformInfo;
  }

  const rawPlatform = os.platform();
  const rawArch = os.arch();
  const cpuCores = os.cpus().length || 1;

  let osType: 'windows' | 'linux' | 'darwin' | 'unknown' = 'unknown';
  if (rawPlatform === 'win32') osType = 'windows';
  else if (rawPlatform === 'linux') osType = 'linux';
  else if (rawPlatform === 'darwin') osType = 'darwin';

  const isWindows = osType === 'windows';
  const isLinux = osType === 'linux';
  const isMacOS = osType === 'darwin';
  const isArm = rawArch === 'arm' || rawArch === 'arm64';

  let isArmbian = false;
  let distro = `${rawPlatform} ${os.release()}`;

  if (isLinux) {
    // Check for Armbian / Debian / Ubuntu / Raspbian in /etc/os-release or /etc/armbian-release
    try {
      if (fs.existsSync('/etc/armbian-release')) {
        isArmbian = true;
        const armbianContent = fs.readFileSync('/etc/armbian-release', 'utf-8');
        const match = armbianContent.match(/VERSION=([^\r\n]+)/);
        distro = `Armbian ${match ? match[1].replace(/"/g, '') : ''}`.trim();
      } else if (fs.existsSync('/etc/os-release')) {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
        if (osRelease.toLowerCase().includes('armbian')) {
          isArmbian = true;
        }
        const nameMatch = osRelease.match(/PRETTY_NAME="?([^"\r\n]+)"?/);
        if (nameMatch && nameMatch[1]) {
          distro = nameMatch[1];
        }
      }
    } catch {
      // Ignore read errors
    }
  } else if (isWindows) {
    distro = `Windows (NT ${os.release()})`;
  } else if (isMacOS) {
    distro = `macOS (${os.release()})`;
  }

  cachedPlatformInfo = {
    os: osType,
    platform: rawPlatform,
    arch: rawArch,
    isWindows,
    isLinux,
    isMacOS,
    isArm,
    isArmbian,
    distro,
    cpuCores
  };

  logger.info(
    `Detected Environment: [${distro}] | Arch: [${rawArch}] | Cores: ${cpuCores} | Armbian: ${isArmbian ? 'YES' : 'NO'}`
  );

  return cachedPlatformInfo;
}

/**
 * Dynamically probes installed FFmpeg capabilities to prevent unrecognized flags across versions.
 * (e.g. -timeout in FFmpeg 5+/6+/7+/8+ vs legacy -stimeout in FFmpeg 3/4).
 */
export function getFfmpegCapabilities(): FfmpegCapabilities {
  if (cachedFfmpegCaps) {
    return cachedFfmpegCaps;
  }

  const platform = getPlatformInfo();

  let available = false;
  let version = 'unknown';
  let rtspTimeoutFlag: '-timeout' | '-stimeout' = '-timeout';
  let supportsNobuffer = true;
  let supportsLowDelay = true;

  try {
    // 1. Probe FFmpeg version
    const verRes = spawnSync('ffmpeg', ['-version'], {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    if (verRes.status === 0 && verRes.stdout) {
      available = true;
      const firstLine = verRes.stdout.split('\n')[0] || '';
      const verMatch = firstLine.match(/version\s+([^\s]+)/i);
      if (verMatch && verMatch[1]) {
        version = verMatch[1];
      }
    }

    // 2. Probe RTSP demuxer options specifically to detect timeout parameter
    const demuxRes = spawnSync('ffmpeg', ['-h', 'demuxer=rtsp'], {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    if (demuxRes.status === 0 && demuxRes.stdout) {
      const output = demuxRes.stdout;
      // If '-timeout' is listed as an AVOption for rtsp demuxer, use '-timeout'
      // Note: in modern FFmpeg, '-timeout' is standard; in older FFmpeg (v3/v4), '-stimeout' is listed.
      const hasTimeout = output.includes('-timeout');
      const hasStimeout = output.includes('-stimeout');

      if (hasTimeout) {
        rtspTimeoutFlag = '-timeout';
      } else if (hasStimeout) {
        rtspTimeoutFlag = '-stimeout';
      }
    } else {
      // Fallback based on major version
      const majorVer = parseInt(version.split('.')[0] || '0', 10);
      if (majorVer >= 5 || platform.isWindows) {
        rtspTimeoutFlag = '-timeout';
      } else {
        rtspTimeoutFlag = '-stimeout';
      }
    }
  } catch (err) {
    logger.warn(`Failed to probe FFmpeg capabilities: ${err}. Using safe defaults.`);
  }

  // On low-powered ARM boards (e.g. S905X Cortex-A53), allocate 1 thread for filter/decode to conserve CPU
  const optimalThreads = platform.isArm ? 1 : Math.min(2, platform.cpuCores);

  cachedFfmpegCaps = {
    available,
    version,
    rtspTimeoutFlag,
    supportsNobuffer,
    supportsLowDelay,
    optimalThreads
  };

  logger.info(
    `FFmpeg probed: v${version} | RTSP Timeout flag: [${rtspTimeoutFlag}] | Optimal Threads: ${optimalThreads}`
  );

  return cachedFfmpegCaps;
}

/**
 * Builds optimized, zero-misconfiguration FFmpeg input arguments
 * dynamically tailored to the detected OS and FFmpeg version.
 * 
 * @param url RTSP or local video URL
 * @returns Array of FFmpeg input command arguments
 */
export function buildFfmpegRtspInputArgs(url: string): string[] {
  const isRtsp = url.startsWith('rtsp://') || url.startsWith('rtsps://');
  const caps = getFfmpegCapabilities();

  if (!isRtsp) {
    // Non-RTSP (e.g. local MP4 / synthetic stream simulator)
    return ['-re', '-i', url];
  }

  const timeoutMicroseconds = '10000000'; // 10 seconds

  return [
    '-rtsp_transport', 'tcp',
    caps.rtspTimeoutFlag, timeoutMicroseconds,
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-use_wallclock_as_timestamps', '1',
    '-analyzeduration', '2000000',
    '-probesize', '2000000',
    '-max_delay', '500000',
    '-reorder_queue_size', '16',
    '-i', url
  ];
}
