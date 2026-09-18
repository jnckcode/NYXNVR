/**
 * @file constants.ts
 * @description System-wide constants, default configurations, and fallback values.
 * @functions DEFAULT_SETTINGS, SYSTEM_CONSTANTS, DEFAULT_ROI_CONFIG
 * @dependencies none
 */

import path from 'path';

export const SYSTEM_CONSTANTS = {
  APP_NAME: 'NYX NVR',
  APP_VERSION: '1.2.0',
  DEFAULT_PORT: 3000,
  DEFAULT_HOST: '0.0.0.0',
  DB_PATH: path.resolve(process.cwd(), 'data', 'nyx_nvr.db'),
  DEFAULT_RECORDING_PATH: path.resolve(process.cwd(), 'storage', 'recordings'),
  DEFAULT_SNAPSHOT_PATH: path.resolve(process.cwd(), 'storage', 'snapshots'),
  DEFAULT_MODEL_PATH: path.resolve(process.cwd(), 'models', 'yolov8n.onnx'),
  DEFAULT_MODELS_DIR: path.resolve(process.cwd(), 'models'),
  DEFAULT_SEGMENT_DURATION_SECONDS: 60, // 1 minute segments — faster recovery on crash, granular indexing
  DEFAULT_RETENTION_DAYS: 7,
  DEFAULT_RETENTION_HOURS: 168, // 7 days * 24 hours
  DEFAULT_AUTO_DELETE_ENABLED: 1,
  DEFAULT_AUTO_DELETE_SNAPSHOTS: 1,
  DEFAULT_DISK_THRESHOLD_PERCENT: 85,

  // Stage 1: Motion Detection — FFmpeg decodes at this resolution for pipe:3
  // MotionFilter internally downscales to MOTION_DETECT_WIDTH×HEIGHT for 12× faster pixel diffing
  STAGE1_FRAME_WIDTH: 640,
  STAGE1_FRAME_HEIGHT: 360,

  // Internal motion detection resolution (used inside MotionFilter for lightweight pixel diff)
  MOTION_DETECT_WIDTH: 160,
  MOTION_DETECT_HEIGHT: 120,

  // Stage 2: ONNX YOLOv8 input size options (supports 416×256 16:9 widescreen or 640×640)
  STAGE2_FRAME_SIZE: 640,
  STAGE2_DEFAULT_WIDTH: 416,
  STAGE2_DEFAULT_HEIGHT: 256,

  // Thermal Guard for ARM STB (Amlogic S905X / H6 / RK3328 / RPi)
  THERMAL_WARNING_TEMP: 75,   // °C: Trigger ECO mode (drop FPS, throttle heartbeat)
  THERMAL_CRITICAL_TEMP: 82,  // °C: Emergency AI cooldown to prevent thermal shutdown
  THERMAL_RECOVERY_TEMP: 72,  // °C: Resume normal performance tier

  STAGE1_MOTION_THRESHOLD_PERCENT: 0.2, // 0.2% pixel change triggers motion burst
  HEARTBEAT_AI_SCAN_INTERVAL_MS: 1000,  // Background AI scan every 1s for stationary object detection
  BURST_AI_FPS: 3,
  MOTION_COOLDOWN_MS: 4000,             // Keep AI alive 4s after last motion
  RETENTION_CHECK_INTERVAL_MS: 15 * 60 * 1000, // Every 15 minutes (was 5min — reduces I/O storm on SD cards)
  MAX_RECONNECT_ATTEMPTS: 10,
  BASE_RECONNECT_DELAY_MS: 2000,
  MAX_RECONNECT_DELAY_MS: 10000         // Max 10s (was 30s — faster surveillance recovery)
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
