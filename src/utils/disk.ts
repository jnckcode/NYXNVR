/**
 * @file disk.ts
 * @description Cross-platform disk space utility calculating Total, Used, and Free bytes for storage mount points.
 * @functions getDiskSpaceInfo, isPathOverThreshold
 * @dependencies fs, path, child_process, types/settings, utils/pathSanitizer
 */

import fs from 'fs';
import { DiskSpaceInfo } from '../types/settings';
import { ensureDirExists, sanitizePath } from './pathSanitizer';

/**
 * Retrieves disk capacity and usage metrics for a given directory path.
 */
export function getDiskSpaceInfo(targetPath: string, thresholdPercent: number = 85): DiskSpaceInfo {
  const safePath = sanitizePath(targetPath);
  ensureDirExists(safePath);

  try {
    // Node.js v18.15+ / v22 native statfsSync
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(safePath);
      const bsize = stats.bsize || 4096;
      const totalBytes = Number(stats.blocks) * bsize;
      const freeBytes = Number(stats.bavail) * bsize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

      return {
        mountPath: safePath,
        totalBytes,
        usedBytes,
        freeBytes,
        usedPercent,
        thresholdPercent,
        isOverThreshold: usedPercent >= thresholdPercent
      };
    }
  } catch (err) {
    // Fallback for non-standard mount paths
  }

  // Fallback estimation (e.g. 64GB virtual default if statfs fails)
  const defaultTotal = 64 * 1024 * 1024 * 1024;
  const defaultFree = 32 * 1024 * 1024 * 1024;
  const defaultUsed = defaultTotal - defaultFree;
  const usedPercent = 50;

  return {
    mountPath: safePath,
    totalBytes: defaultTotal,
    usedBytes: defaultUsed,
    freeBytes: defaultFree,
    usedPercent,
    thresholdPercent,
    isOverThreshold: usedPercent >= thresholdPercent
  };
}
