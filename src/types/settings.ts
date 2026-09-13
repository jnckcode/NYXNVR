/**
 * @file settings.ts
 * @description Type definitions for dynamic system settings and configuration parameters.
 * @functions SystemSetting, SystemSettingsMap, DiskSpaceInfo
 * @dependencies none
 */

export interface SystemSetting {
  key: string;
  value: string;
}

export interface SystemSettingsMap {
  recording_path: string;
  ai_model_path: string;
  retention_days: number;
  retention_hours?: number;
  auto_delete_enabled?: number;
  auto_delete_snapshots?: number;
  disk_threshold_percent: number;
  ai_confidence_threshold?: number;
  ai_iou_threshold?: number;
  ai_target_classes?: string;
  ai_continuous_mode?: number;
  ai_motion_sensitivity?: number;
  [key: string]: string | number | undefined;
}

export interface DiskSpaceInfo {
  mountPath: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  thresholdPercent: number;
  isOverThreshold: boolean;
}
