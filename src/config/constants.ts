/**
 * @file constants.ts
 * @description System-wide constants, default configurations, and fallback values.
 * @functions DEFAULT_SETTINGS, SYSTEM_CONSTANTS, DEFAULT_ROI_CONFIG
 * @dependencies none
 */

import path from 'path';

export const SYSTEM_CONSTANTS = {
  APP_NAME: 'Antigravity NVR',
  APP_VERSION: '1.1.0',
  DEFAULT_PORT: 3000,
  DEFAULT_HOST: '0.0.0.0',
  DB_PATH: path.resolve(process.cwd(), 'data', 'antigravity_nvr.db'),
  DEFAULT_RECORDING_PATH: path.resolve(process.cwd(), 'storage', 'recordings'),
  DEFAULT_SNAPSHOT_PATH: path.resolve(process.cwd(), 'storage', 'snapshots'),
  DEFAULT_MODEL_PATH: path.resolve(process.cwd(), 'models', 'yolov8n.onnx'),
  DEFAULT_MODELS_DIR: path.resolve(process.cwd(), 'models'),
  DEFAULT_SEGMENT_DURATION_SECONDS: 300, // 5 minutes
  DEFAULT_RETENTION_DAYS: 7,
  DEFAULT_RETENTION_HOURS: 168, // 7 days * 24 hours
  DEFAULT_AUTO_DELETE_ENABLED: 1, // Auto purge enabled by default
  DEFAULT_AUTO_DELETE_SNAPSHOTS: 1, // Auto purge event snapshots older than retention window
  DEFAULT_DISK_THRESHOLD_PERCENT: 85,
  STAGE1_FRAME_WIDTH: 640,
  STAGE1_FRAME_HEIGHT: 360,
  STAGE2_FRAME_SIZE: 640,
  STAGE1_MOTION_THRESHOLD_PERCENT: 0.4, // 0.4% pixel change triggers motion burst
  HEARTBEAT_AI_SCAN_INTERVAL_MS: 1500, // Background AI scan every 1.5s to maintain stationary object detection
  BURST_AI_FPS: 3,
  MOTION_COOLDOWN_MS: 4000, // Keep AI alive 4 seconds after last motion
  RETENTION_CHECK_INTERVAL_MS: 5 * 60 * 1000, // Every 5 minutes
  MAX_RECONNECT_ATTEMPTS: 10,
  BASE_RECONNECT_DELAY_MS: 2000,
  MAX_RECONNECT_DELAY_MS: 30000
};

export const DEFAULT_SETTINGS = {
  recording_path: SYSTEM_CONSTANTS.DEFAULT_RECORDING_PATH,
  ai_model_path: SYSTEM_CONSTANTS.DEFAULT_MODEL_PATH,
  retention_days: SYSTEM_CONSTANTS.DEFAULT_RETENTION_DAYS.toString(),
  retention_hours: SYSTEM_CONSTANTS.DEFAULT_RETENTION_HOURS.toString(),
  auto_delete_enabled: '1',
  auto_delete_snapshots: '1',
  disk_threshold_percent: SYSTEM_CONSTANTS.DEFAULT_DISK_THRESHOLD_PERCENT.toString()
};

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop',
  'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
];

export const TARGET_SECURITY_CLASSES = new Set([
  'person', 'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'dog', 'cat'
]);
