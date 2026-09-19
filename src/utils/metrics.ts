/**
 * @file metrics.ts
 * @description System metrics monitoring utility measuring CPU load and RAM footprint for ARM64 STB environments.
 * @functions getSystemMetrics, getProcessMemoryMb
 * @dependencies os, types/system
 */

import fs from 'fs';
import os from 'os';
import { SystemMetrics, ProcessMemoryInfo } from '../types/system';
import { getPlatformInfo } from './platform';

let lastCpuMeasure = {
  idle: 0,
  total: 0,
  time: Date.now()
};

function getCpuTimes(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    total += user + nice + sys + cpuIdle + irq;
    idle += cpuIdle;
  }

  return { idle, total };
}

// Initialize first measurement
const initial = getCpuTimes();
lastCpuMeasure = { ...initial, time: Date.now() };

/**
 * Calculates current CPU usage percentage across all cores.
 */
function calculateCpuUsage(): number {
  const current = getCpuTimes();
  const idleDiff = current.idle - lastCpuMeasure.idle;
  const totalDiff = current.total - lastCpuMeasure.total;

  lastCpuMeasure = { ...current, time: Date.now() };

  if (totalDiff <= 0) return 0;
  const usage = 100 - Math.round((idleDiff / totalDiff) * 100);
  return Math.max(0, Math.min(100, usage));
}

let lastProcessCpu = process.cpuUsage();
let lastProcessTime = Date.now();

/**
 * Calculates current CPU usage percentage of the NVR Node.js process itself.
 */
function calculateProcessCpuUsage(): number {
  const currentCpu = process.cpuUsage(lastProcessCpu);
  const currentTime = Date.now();
  const timeDiffMs = currentTime - lastProcessTime;

  lastProcessCpu = process.cpuUsage();
  lastProcessTime = currentTime;

  if (timeDiffMs <= 0) return 0;

  const numCores = os.cpus().length || 1;
  const totalMicroSec = currentCpu.user + currentCpu.system;
  // Convert microseconds to fraction of total time across cores
  const percent = Math.round((totalMicroSec / (timeDiffMs * 1000 * numCores)) * 100);
  return Math.max(0, Math.min(100, percent));
}

/**
 * Returns formatted process memory metrics in Megabytes.
 */
export function getProcessMemoryMb(): ProcessMemoryInfo {
  const mem = process.memoryUsage();
  return {
    rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
    heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10,
    heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    externalMb: Math.round((mem.external / (1024 * 1024)) * 10) / 10
  };
}

/**
 * Reads CPU temperature on Linux/Armbian SBCs (/sys/class/thermal/thermal_zone0/temp).
 * Returns temperature in Celsius (e.g., 55.4) or undefined if not available.
 */
export function getCpuTemperature(): number | undefined {
  if (getPlatformInfo().isLinux) {
    const thermalPaths = [
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/thermal/thermal_zone1/temp',
      '/sys/devices/virtual/thermal/thermal_zone0/temp'
    ];

    for (const tPath of thermalPaths) {
      try {
        if (fs.existsSync(tPath)) {
          const raw = fs.readFileSync(tPath, 'utf-8').trim();
          const val = parseFloat(raw);
          if (!isNaN(val) && val > 0) {
            // Kernel thermal reports in millidegrees Celsius (e.g., 55000 = 55.0°C)
            const tempC = val > 1000 ? val / 1000 : val;
            return Math.round(tempC * 10) / 10;
          }
        }
      } catch {
        // Continue to next path
      }
    }
  }
  return undefined;
}

/**
 * Returns comprehensive hardware and system metrics.
 * On Linux, utilizes /proc/meminfo MemAvailable so disk buffers/page cache are not miscounted as used RAM.
 */
export function getSystemMetrics(activeStreamsCount: number = 0, activeAICount: number = 0): SystemMetrics {
  const cpus = os.cpus();
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  let freeMemMb = Math.round(os.freemem() / (1024 * 1024));
  const platformInfo = getPlatformInfo();

  // Linux kernel page-cache awareness:
  // os.freemem() only returns raw MemFree (ignoring reclaimable disk page buffers).
  // Reading MemAvailable from /proc/meminfo gives the true usable RAM.
  if (platformInfo.isLinux) {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
      const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (match && match[1]) {
        freeMemMb = Math.round(parseInt(match[1], 10) / 1024);
      }
    } catch {
      // Fallback to os.freemem()
    }
  }

  const usedMemMb = Math.max(0, totalMemMb - freeMemMb);
  const systemCpu = calculateCpuUsage();
  const processCpu = calculateProcessCpuUsage();
  const cpuTemp = getCpuTemperature();

  return {
    uptimeSeconds: Math.round(process.uptime()),
    platform: platformInfo.platform,
    arch: platformInfo.arch,
    cpuModel: cpus.length > 0 ? cpus[0].model : 'ARM Cortex-A53',
    cpuCores: cpus.length,
    cpuUsagePercent: processCpu, // Default CPU metric focuses on NVR Node process footprint
    processCpuPercent: processCpu,
    systemCpuPercent: systemCpu,
    totalMemMb,
    freeMemMb,
    usedMemMb,
    processMemory: getProcessMemoryMb(),
    activeStreamsCount,
    activeAICount,
    cpuTemp,
    isThermalThrottled: cpuTemp !== undefined && cpuTemp >= 75
  };
}
