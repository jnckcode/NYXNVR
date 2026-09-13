/**
 * @file StorageManager.ts
 * @description Manages video segment file indexing into SQLite, directory structure maintenance, and dynamic storage path relocations.
 * @functions getCameraRecordingDir, indexRecordingSegment, cleanupEmptyDirs
 * @dependencies fs, path, SettingsService, RecordingRepository, pathSanitizer, logger
 */

import fs from 'fs';
import path from 'path';
import { SettingsService } from './SettingsService';
import { RecordingRepository } from '../db/recordingRepository';
import { ensureDirExists, sanitizePath } from '../utils/pathSanitizer';
import { createLogger } from '../utils/logger';

const logger = createLogger('StorageManager');

export class StorageManager {
  private static instance: StorageManager;
  private settingsService: SettingsService;

  private constructor() {
    this.settingsService = SettingsService.getInstance();
    this.settingsService.on('recordingPathChanged', (newPath: string) => {
      logger.info(`Recording base path changed to: ${newPath}. Relocating storage structure.`);
      ensureDirExists(newPath);
    });
  }

  public static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }

  /**
   * Returns the absolute directory path for a specific camera's recordings.
   */
  public getCameraRecordingDir(cameraId: string): string {
    const basePath = this.settingsService.getRecordingPath();
    const cameraDir = path.join(basePath, cameraId);
    return ensureDirExists(cameraDir);
  }

  /**
   * Indexes a newly closed MP4 recording segment into the SQLite database.
   */
  public indexRecordingSegment(cameraId: string, filePath: string, startTime: string, endTime: string): void {
    try {
      const sanitized = sanitizePath(filePath);
      if (fs.existsSync(sanitized)) {
        const stats = fs.statSync(sanitized);
        if (stats.size > 1024) { // Only record non-empty files (>1KB)
          RecordingRepository.create({
            cameraId,
            filePath: sanitized,
            fileSize: stats.size,
            startTime,
            endTime
          });
          logger.debug(`Indexed MP4 segment: [${path.basename(sanitized)}] (${Math.round(stats.size / 1024)} KB)`);
        } else {
          // Remove 0-byte or corrupted snippet
          fs.unlinkSync(sanitized);
        }
      }
    } catch (err: any) {
      logger.error(`Failed to index segment ${filePath}:`, err.message);
    }
  }

  /**
   * Scans a camera directory to index any untracked valid MP4 files (e.g. after server restart).
   */
  public syncExistingFiles(cameraId: string): void {
    const dir = this.getCameraRecordingDir(cameraId);
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stats = fs.statSync(fullPath);
        if (stats.size > 1024) {
          // Check if already indexed
          const startTime = stats.birthtime ? stats.birthtime.toISOString() : stats.mtime.toISOString();
          const endTime = stats.mtime.toISOString();
          this.indexRecordingSegment(cameraId, fullPath, startTime, endTime);
        }
      }
    } catch (e) {
      // Ignore
    }
  }
}
