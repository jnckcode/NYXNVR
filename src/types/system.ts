/**
 * @file system.ts
 * @description Type definitions for hardware resource metrics (CPU, RAM) and system health diagnostics.
 * @functions SystemMetrics, ProcessMemoryInfo, CPULoadInfo
 * @dependencies none
 */

export interface ProcessMemoryInfo {
  rssMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  externalMb: number;
}

export interface SystemMetrics {
  uptimeSeconds: number;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsagePercent: number;
  processCpuPercent?: number;
  systemCpuPercent?: number;
  totalMemMb: number;
  freeMemMb: number;
  usedMemMb: number;
  processMemory: ProcessMemoryInfo;
  activeStreamsCount: number;
  activeAICount: number;
}
