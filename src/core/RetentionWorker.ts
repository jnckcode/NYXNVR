/**
 * @file RetentionWorker.ts
 * @description Background retention job enforcing disk threshold limits and time-based auto-purging of expired MP4 video recordings and AI snapshots.
 * @functions start, stop, executeRetentionCycle, purgeOldRecordings, enforceDiskThreshold, getRetentionStatus
 * @dependencies fs, path, SettingsService, RecordingRepository, EventRepository, logger, constants
 */

import fs from 'fs';
import path from 'path';
import { SettingsService } from './SettingsService';
import { RecordingRepository } from '../db/recordingRepository';
import { EventRepository } from '../db/eventRepository';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';

const logger = createLogger('RetentionWorker');

export interface RetentionCycleResult {
  purgedByAge: number;
  purgedByDisk: number;
  purgedSnapshots: number;
  freedBytes: number;
  freedHuman: string;
}

export interface RetentionLastStats {
  lastRunTime: string | null;
  purgedRecordings: number;
  purgedSnapshots: number;
  freedBytes: number;
  freedHuman: string;
  lastTrigger: 'interval' | 'manual';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export class RetentionWorker {
  private static instance: RetentionWorker;
  private settingsService: SettingsService;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunningCycle: boolean = false;
  private lastStats: RetentionLastStats = {
    lastRunTime: null,
    purgedRecordings: 0,
    purgedSnapshots: 0,
    freedBytes: 0,
    freedHuman: '0 B',
    lastTrigger: 'interval'
  };

  private constructor() {
    this.settingsService = SettingsService.getInstance();
  }

  public static getInstance(): RetentionWorker {
    if (!RetentionWorker.instance) {
      RetentionWorker.instance = new RetentionWorker();
    }
    return RetentionWorker.instance;
  }

  /**
   * Starts the background periodic retention worker.
   */
  public start(intervalMs: number = SYSTEM_CONSTANTS.RETENTION_CHECK_INTERVAL_MS): void {
    if (this.intervalTimer) return;

    logger.info(`Starting RetentionWorker interval: every ${Math.round(intervalMs / 1000 / 60)} minutes.`);
    this.intervalTimer = setInterval(() => {
      this.executeRetentionCycle(false);
    }, intervalMs);

    // Run first cycle shortly after start (after 10s)
    setTimeout(() => this.executeRetentionCycle(false), 10000);
  }

  /**
   * Stops the background retention timer.
   */
  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      logger.info('RetentionWorker stopped.');
    }
  }

  /**
   * Returns current retention status, policies, oldest recording, and last run statistics.
   */
  public getRetentionStatus(): {
    auto_delete_enabled: boolean;
    retention_hours: number;
    retention_days: number;
    auto_delete_snapshots: boolean;
    disk_threshold_percent: number;
    oldest_recording: any | null;
    last_stats: RetentionLastStats;
    is_running: boolean;
  } {
    const oldest = RecordingRepository.getOldestRecording();
    return {
      auto_delete_enabled: this.settingsService.isAutoDeleteEnabled(),
      retention_hours: this.settingsService.getRetentionHours(),
      retention_days: this.settingsService.getRetentionDays(),
      auto_delete_snapshots: this.settingsService.isAutoDeleteSnapshotsEnabled(),
      disk_threshold_percent: this.settingsService.getDiskThresholdPercent(),
      oldest_recording: oldest,
      last_stats: { ...this.lastStats },
      is_running: this.isRunningCycle
    };
  }

  /**
   * Runs a complete retention cycle: age-based cleanup followed by disk threshold enforcement.
   */
  public async executeRetentionCycle(isManual: boolean = false): Promise<RetentionCycleResult> {
    if (this.isRunningCycle) {
      logger.warn('Retention cycle already in progress, skipping duplicate tick.');
      return {
        purgedByAge: 0,
        purgedByDisk: 0,
        purgedSnapshots: 0,
        freedBytes: 0,
        freedHuman: '0 B'
      };
    }

    this.isRunningCycle = true;
    let purgedByAge = 0;
    let purgedByDisk = 0;
    let purgedSnapshots = 0;
    let freedBytes = 0;

    try {
      logger.debug(`Executing retention cycle (trigger: ${isManual ? 'MANUAL' : 'INTERVAL'})...`);

      // 1. Purge expired recordings & snapshots if auto-delete is enabled (or if manual purge triggered)
      if (this.settingsService.isAutoDeleteEnabled() || isManual) {
        const agePurge = await this.purgeOldRecordings();
        purgedByAge += agePurge.purgedRecordings;
        purgedSnapshots += agePurge.purgedSnapshots;
        freedBytes += agePurge.freedBytes;
      } else {
        logger.debug('Auto-delete is disabled in settings; skipping age-based purge.');
      }

      // 2. Enforce emergency disk threshold limit
      const diskPurge = await this.enforceDiskThreshold();
      purgedByDisk += diskPurge.purgedRecordings;
      freedBytes += diskPurge.freedBytes;

      // Update statistics
      this.lastStats = {
        lastRunTime: new Date().toISOString(),
        purgedRecordings: purgedByAge + purgedByDisk,
        purgedSnapshots,
        freedBytes,
        freedHuman: formatBytes(freedBytes),
        lastTrigger: isManual ? 'manual' : 'interval'
      };

      if (purgedByAge > 0 || purgedByDisk > 0 || purgedSnapshots > 0) {
        logger.info(
          `Retention cycle complete: ${purgedByAge} recordings purged by age, ${purgedByDisk} by disk threshold, ` +
          `${purgedSnapshots} snapshots cleaned. Total freed: ${formatBytes(freedBytes)}.`
        );
      }
    } catch (err: any) {
      logger.error('Error during retention cycle execution:', err.message);
    } finally {
      this.isRunningCycle = false;
    }

    return {
      purgedByAge,
      purgedByDisk,
      purgedSnapshots,
      freedBytes,
      freedHuman: formatBytes(freedBytes)
    };
  }

  /**
   * Purges recording files and AI event snapshots older than retention_hours.
   */
  private async purgeOldRecordings(): Promise<{
    purgedRecordings: number;
    purgedSnapshots: number;
    freedBytes: number;
  }> {
    const retentionHours = this.settingsService.getRetentionHours();
    const cutoffDate = new Date(Date.now() - retentionHours * 3600 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    let purgedRecordings = 0;
    let purgedSnapshots = 0;
    let freedBytes = 0;

    // 1. Purge expired MP4 recordings from SQLite and disk
    const expiredRecordings = RecordingRepository.getRecordingsOlderThan(cutoffIso);
    if (expiredRecordings.length > 0) {
      logger.info(`Found ${expiredRecordings.length} expired recording(s) older than ${retentionHours} hour(s) (${cutoffIso}).`);
      for (const rec of expiredRecordings) {
        const deletedSize = this.deleteRecordingFileAndRecord(rec.id, rec.file_path);
        freedBytes += deletedSize;
        purgedRecordings++;
      }
    }

    // 2. Also clean expired AI snapshots & event records if enabled
    if (this.settingsService.isAutoDeleteSnapshotsEnabled()) {
      const expiredEvents = EventRepository.getEventsOlderThan(cutoffIso);
      if (expiredEvents.length > 0) {
        logger.info(`Found ${expiredEvents.length} expired AI detection event(s) older than ${retentionHours} hour(s).`);
        const snapDir = SYSTEM_CONSTANTS.DEFAULT_SNAPSHOT_PATH;
        const eventIdsToDelete: string[] = [];

        for (const evt of expiredEvents) {
          eventIdsToDelete.push(evt.id);
          if (evt.snapshot_path) {
            try {
              const fullSnapPath = path.isAbsolute(evt.snapshot_path)
                ? evt.snapshot_path
                : path.join(snapDir, evt.snapshot_path);

              if (fs.existsSync(fullSnapPath)) {
                const stat = fs.statSync(fullSnapPath);
                freedBytes += stat.size;
                fs.unlinkSync(fullSnapPath);
                purgedSnapshots++;
              }
            } catch (err: any) {
              logger.warn(`Could not delete snapshot for event ${evt.id}: ${err.message}`);
            }
          }
        }

        EventRepository.deleteBatch(eventIdsToDelete);
      }
    }

    // 3. Scan camera recording folders for any dangling/orphan MP4 files older than cutoff
    try {
      const recBaseDir = this.settingsService.getRecordingPath();
      if (fs.existsSync(recBaseDir)) {
        const camFolders = fs.readdirSync(recBaseDir, { withFileTypes: true });
        for (const folder of camFolders) {
          if (folder.isDirectory()) {
            const camDir = path.join(recBaseDir, folder.name);
            const files = fs.readdirSync(camDir);
            for (const file of files) {
              if (file.endsWith('.mp4')) {
                const fullPath = path.join(camDir, file);
                try {
                  const stat = fs.statSync(fullPath);
                  if (stat.mtimeMs < cutoffDate.getTime()) {
                    freedBytes += stat.size;
                    fs.unlinkSync(fullPath);
                    purgedRecordings++;
                    logger.debug(`Purged orphan expired recording: ${file}`);
                  }
                } catch (e) {
                  // Ignore
                }
              }
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn('Failed during orphan file scan in recordings directory:', err.message);
    }

    return { purgedRecordings, purgedSnapshots, freedBytes };
  }

  /**
   * Checks if disk threshold is exceeded; if so, purges oldest files iteratively until within limit.
   */
  private async enforceDiskThreshold(): Promise<{ purgedRecordings: number; freedBytes: number }> {
    let purgedRecordings = 0;
    let freedBytes = 0;
    const maxIterations = 50; // Safety cap per cycle
    let iterations = 0;

    while (iterations < maxIterations) {
      const diskInfo = this.settingsService.getDiskInfo();
      if (!diskInfo.isOverThreshold) {
        break;
      }

      logger.warn(`Disk space over threshold! Used: ${diskInfo.usedPercent}%, Threshold: ${diskInfo.thresholdPercent}%. Purging oldest segment...`);

      const oldest = RecordingRepository.getOldestRecordings(1);
      if (oldest.length === 0) {
        logger.warn('No more recordings in database to purge, but disk remains full.');
        break;
      }

      const target = oldest[0];
      const deletedSize = this.deleteRecordingFileAndRecord(target.id, target.file_path);
      freedBytes += deletedSize;
      purgedRecordings++;
      iterations++;
    }

    return { purgedRecordings, freedBytes };
  }

  /**
   * Safely removes the MP4 file from disk and deletes the SQLite database row.
   * Returns the number of freed bytes.
   */
  private deleteRecordingFileAndRecord(id: string, filePath: string): number {
    let freed = 0;
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        freed = stat.size;
        fs.unlinkSync(filePath);
        logger.debug(`Deleted recording file: ${path.basename(filePath)} (${formatBytes(freed)})`);
      }
    } catch (err: any) {
      logger.warn(`Could not delete file ${filePath} from disk: ${err.message}`);
    } finally {
      RecordingRepository.deleteById(id);
    }
    return freed;
  }
}
