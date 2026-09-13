/**
 * @file SettingsService.ts
 * @description Central service for managing dynamic system configurations, validating custom storage paths, and broadcasting hot-reload events.
 * @functions getSettings, updateSettings, getRecordingPath, getModelPath, getDiskInfo
 * @dependencies events, SettingsRepository, disk, pathSanitizer, constants
 */

import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import { SettingsRepository } from '../db/settingsRepository';
import { SystemSettingsMap, DiskSpaceInfo } from '../types/settings';
import { getDiskSpaceInfo } from '../utils/disk';
import { ensureDirExists, sanitizePath } from '../utils/pathSanitizer';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';

const logger = createLogger('SettingsService');

export class SettingsService extends EventEmitter {
  private static instance: SettingsService;
  private cachedSettings: SystemSettingsMap;

  private constructor() {
    super();
    this.cachedSettings = SettingsRepository.getAll();
    this.initializeDirectories();
  }

  public static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      SettingsService.instance = new SettingsService();
    }
    return SettingsService.instance;
  }

  /**
   * Ensures essential system directories (recording, snapshot, models) exist on disk.
   */
  public initializeDirectories(): void {
    const recPath = this.getRecordingPath();
    const snapPath = SYSTEM_CONSTANTS.DEFAULT_SNAPSHOT_PATH;
    const modelPath = path.dirname(this.getModelPath());

    ensureDirExists(recPath);
    ensureDirExists(snapPath);
    ensureDirExists(modelPath);

    logger.info(`Storage directories verified: Recording=[${recPath}], Snapshots=[${snapPath}]`);
  }

  /**
   * Returns current dynamic settings map.
   */
  public getSettings(): SystemSettingsMap {
    return { ...this.cachedSettings };
  }

  /**
   * Retrieves the active recording storage path.
   */
  public getRecordingPath(): string {
    return sanitizePath(this.cachedSettings.recording_path || SYSTEM_CONSTANTS.DEFAULT_RECORDING_PATH);
  }

  /**
   * Retrieves the active ONNX model path.
   */
  public getModelPath(): string {
    return sanitizePath(this.cachedSettings.ai_model_path || SYSTEM_CONSTANTS.DEFAULT_MODEL_PATH);
  }

  /**
   * Retrieves retention days.
   */
  public getRetentionDays(): number {
    return Number(this.cachedSettings.retention_days) || SYSTEM_CONSTANTS.DEFAULT_RETENTION_DAYS;
  }

  /**
   * Retrieves retention period in hours.
   */
  public getRetentionHours(): number {
    if (this.cachedSettings.retention_hours !== undefined) {
      const h = Number(this.cachedSettings.retention_hours);
      if (!isNaN(h) && h > 0) return h;
    }
    return this.getRetentionDays() * 24;
  }

  /**
   * Checks if automatic time-based purge is enabled.
   */
  public isAutoDeleteEnabled(): boolean {
    if (this.cachedSettings.auto_delete_enabled !== undefined) {
      return Number(this.cachedSettings.auto_delete_enabled) === 1;
    }
    return SYSTEM_CONSTANTS.DEFAULT_AUTO_DELETE_ENABLED === 1;
  }

  /**
   * Checks if automatic purge should also delete expired AI snapshots & event logs.
   */
  public isAutoDeleteSnapshotsEnabled(): boolean {
    if (this.cachedSettings.auto_delete_snapshots !== undefined) {
      return Number(this.cachedSettings.auto_delete_snapshots) === 1;
    }
    return SYSTEM_CONSTANTS.DEFAULT_AUTO_DELETE_SNAPSHOTS === 1;
  }

  /**
   * Retrieves disk space threshold percentage.
   */
  public getDiskThresholdPercent(): number {
    return Number(this.cachedSettings.disk_threshold_percent) || SYSTEM_CONSTANTS.DEFAULT_DISK_THRESHOLD_PERCENT;
  }

  /**
   * Retrieves AI detection confidence threshold (e.g. 0.25).
   */
  public getAiConfidenceThreshold(): number {
    const val = Number(this.cachedSettings.ai_confidence_threshold);
    return isNaN(val) ? 0.20 : val;
  }

  /**
   * Retrieves AI IoU NMS threshold (e.g. 0.45).
   */
  public getAiIouThreshold(): number {
    return Number(this.cachedSettings.ai_iou_threshold) || 0.45;
  }

  /**
   * Retrieves array of target object class labels to detect.
   */
  public getAiTargetClasses(): string[] {
    const raw = String(this.cachedSettings.ai_target_classes || 'all').trim().toLowerCase();
    if (raw === 'all' || raw === '*') return ['all'];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  /**
   * Checks if Continuous AI scan mode is enabled (runs even without Stage 1 motion).
   */
  public isContinuousAiEnabled(): boolean {
    return Number(this.cachedSettings.ai_continuous_mode) === 1;
  }

  /**
   * Retrieves Stage 1 motion sensitivity percent (e.g. 0.4%).
   */
  public getAiMotionSensitivity(): number {
    const val = Number(this.cachedSettings.ai_motion_sensitivity);
    return isNaN(val) ? 0.4 : val;
  }

  /**
   * Calculates disk metrics for the currently configured recording path.
   */
  public getDiskInfo(): DiskSpaceInfo {
    const recPath = this.getRecordingPath();
    const threshold = this.getDiskThresholdPercent();
    return getDiskSpaceInfo(recPath, threshold);
  }

  /**
   * Updates system settings dynamically in SQLite, applies directory creations, and triggers hot-reload events.
   */
  public updateSettings(newSettings: Partial<SystemSettingsMap>): SystemSettingsMap {
    const oldRecPath = this.cachedSettings.recording_path;
    const oldModelPath = this.cachedSettings.ai_model_path;

    if (newSettings.recording_path) {
      newSettings.recording_path = sanitizePath(newSettings.recording_path);
      ensureDirExists(newSettings.recording_path);
    }

    if (newSettings.ai_model_path) {
      newSettings.ai_model_path = sanitizePath(newSettings.ai_model_path);
      const modelDir = path.dirname(newSettings.ai_model_path);
      ensureDirExists(modelDir);
    }

    if (newSettings.retention_hours !== undefined) {
      newSettings.retention_hours = Math.max(1, Number(newSettings.retention_hours));
      newSettings.retention_days = Math.max(1, Math.round(Number(newSettings.retention_hours) / 24));
    } else if (newSettings.retention_days !== undefined) {
      newSettings.retention_days = Math.max(1, Number(newSettings.retention_days));
      newSettings.retention_hours = newSettings.retention_days * 24;
    }

    if (newSettings.auto_delete_enabled !== undefined) {
      newSettings.auto_delete_enabled = Number(newSettings.auto_delete_enabled) ? 1 : 0;
    }

    if (newSettings.auto_delete_snapshots !== undefined) {
      newSettings.auto_delete_snapshots = Number(newSettings.auto_delete_snapshots) ? 1 : 0;
    }

    if (newSettings.disk_threshold_percent !== undefined) {
      newSettings.disk_threshold_percent = Math.min(99, Math.max(50, Number(newSettings.disk_threshold_percent)));
    }

    SettingsRepository.setBatch(newSettings);
    this.cachedSettings = SettingsRepository.getAll();

    logger.info('System settings updated successfully', this.cachedSettings);

    // Trigger specific hot-reload events if paths changed
    if (newSettings.recording_path && newSettings.recording_path !== oldRecPath) {
      this.emit('recordingPathChanged', this.cachedSettings.recording_path);
    }

    if (newSettings.ai_model_path && newSettings.ai_model_path !== oldModelPath) {
      this.emit('modelPathChanged', this.cachedSettings.ai_model_path);
    }

    this.emit('settingsUpdated', this.cachedSettings);
    return this.getSettings();
  }
}
