/**
 * @file AIAnalyticsEngine.ts
 * @description Dynamic Two-Stage AI Analytics Coordinator with per-camera inference locking.
 * 
 * Optimizations over v1.1:
 * - Per-camera inference lock: Camera A doesn't block Camera B from being analyzed
 * - Per-camera throttle: Each camera has independent 250ms throttle window
 * - Higher default confidence threshold (0.35) for fewer false positives
 * - MotionFilter uses internal 160×120 downscale for 12× faster motion detection
 * 
 * @functions processStage1Frame, processStage2Inference, setCameraROI, toggleCameraAI, reloadModel
 * @dependencies worker_threads, events, fs, path, MotionFilter, SettingsService, EventRepository, CameraRepository, logger
 */

import EventEmitter from 'events';
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { MotionFilter } from './MotionFilter';
import { SettingsService } from '../core/SettingsService';
import { LoadGovernor } from '../core/LoadGovernor';
import { EventRepository } from '../db/eventRepository';
import { CameraRepository } from '../db/cameraRepository';
import { ROIConfig, Camera } from '../types/camera';
import { BoundingBox, DetectionResult } from '../types/event';
import { ensureDirExists, sanitizePath } from '../utils/pathSanitizer';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';

const logger = createLogger('AIAnalyticsEngine');

/** Minimum interval between inferences for the SAME camera (ms) */
const PER_CAMERA_THROTTLE_MS = 250;
/** Minimum cooldown between database logging & alert notifications for the same camera + class (ms) */
const ALERT_DEDUPLICATION_COOLDOWN_MS = 15000;

export class AIAnalyticsEngine extends EventEmitter {
  private static instance: AIAnalyticsEngine;
  private settingsService: SettingsService;
  private loadGovernor: LoadGovernor;
  private worker: Worker | null = null;
  private motionFilters: Map<string, MotionFilter> = new Map();
  private lastMotionTime: Map<string, number> = new Map();
  private isWorkerReady: boolean = false;

  /** Per-camera inference state — replaces global single-lock */
  private inferringCameras: Set<string> = new Set();
  private lastInferencePerCamera: Map<string, number> = new Map();
  private inferenceStartTimes: Map<string, number> = new Map();
  /** Tracks last alert timestamp per camera + class to prevent toast / DB event spamming */
  private lastAlertPerCameraClass: Map<string, number> = new Map();

  private constructor() {
    super();
    this.settingsService = SettingsService.getInstance();
    this.loadGovernor = LoadGovernor.getInstance();
    this.initializeWorker();

    // Listen to dynamic model path changes for seamless hot-reloading
    this.settingsService.on('modelPathChanged', (newModelPath: string) => {
      logger.info(`Model path changed to [${newModelPath}]. Hot-reloading AI worker...`);
      this.reloadModel(newModelPath);
    });
  }

  public static getInstance(): AIAnalyticsEngine {
    if (!AIAnalyticsEngine.instance) {
      AIAnalyticsEngine.instance = new AIAnalyticsEngine();
    }
    return AIAnalyticsEngine.instance;
  }

  /**
   * Spawns the ONNX worker thread.
   */
  private initializeWorker(): void {
    const isTsNode = process.execArgv.some(arg => arg.includes('ts-node')) || __filename.endsWith('.ts');
    const workerPath = isTsNode
      ? path.resolve(__dirname, 'ONNXInferenceWorker.ts')
      : path.resolve(__dirname, 'ONNXInferenceWorker.js');

    try {
      this.worker = new Worker(workerPath, {
        execArgv: isTsNode ? ['-r', 'ts-node/register'] : undefined
      });

      this.worker.on('message', (msg: any) => {
        this.handleWorkerMessage(msg);
      });

      this.worker.on('error', (err) => {
        logger.error('AI Worker thread error:', err);
      });

      this.worker.on('exit', (code) => {
        logger.warn(`AI Worker thread exited with code ${code}. Restarting...`);
        this.isWorkerReady = false;
        setTimeout(() => this.initializeWorker(), 2000);
      });

      // Send initial model path
      const modelPath = this.settingsService.getModelPath();
      this.worker.postMessage({
        type: 'INIT',
        modelPath
      });

      logger.info(`AI Worker thread spawned. Model path: ${modelPath}`);
    } catch (err: any) {
      logger.error('Failed to spawn AI Worker thread:', err.message);
    }
  }

  /**
   * Handles messages returned by the ONNX worker thread.
   */
  private handleWorkerMessage(msg: any): void {
    if (msg.type === 'MODEL_LOADED') {
      this.isWorkerReady = msg.success;
      logger.info(`AI Model load status: ${msg.success ? 'READY' : 'FAILED'} (${msg.modelPath})`);
    } else if (msg.type === 'INFER_RESULT') {
      this.handleInferenceResult(msg);
    }
  }

  /**
   * Processes Stage 2 inference results, saves snapshots, and writes SQLite event records with deduplication.
   */
  private handleInferenceResult(res: {
    cameraId: string;
    timestamp: string;
    boxes: BoundingBox[];
    durationMs: number;
    status: string;
    jpegBuffer?: Uint8Array | null;
  }): void {
    // Release per-camera lock
    this.inferringCameras.delete(res.cameraId);
    this.inferenceStartTimes.delete(res.cameraId);
    this.lastInferencePerCamera.set(res.cameraId, Date.now());

    // Notify Load Governor of real-time inference duration
    if (res.durationMs > 0) {
      this.loadGovernor.recordInferenceDuration(res.durationMs);
    }

    const hasBoxes = res.boxes && res.boxes.length > 0;
    let event: any = null;

    if (hasBoxes) {
      const cam = CameraRepository.getById(res.cameraId);
      const camName = cam ? cam.name : res.cameraId;
      const primaryDetection = res.boxes[0];
      const alertKey = `${res.cameraId}_${primaryDetection.label.toLowerCase()}`;
      const now = Date.now();
      const lastAlert = this.lastAlertPerCameraClass.get(alertKey) || 0;

      // Deduplication: record to DB and trigger toast alert every 10 seconds per camera/class
      if (now - lastAlert >= 10000) {
        this.lastAlertPerCameraClass.set(alertKey, now);

        let snapshotRelPath = '';
        if (res.jpegBuffer) {
          try {
            const snapDir = SYSTEM_CONSTANTS.DEFAULT_SNAPSHOT_PATH;
            ensureDirExists(snapDir);
            const fileName = `${res.cameraId}_${Date.now()}.jpg`;
            const fullSnapPath = path.join(snapDir, fileName);

            fs.promises.writeFile(fullSnapPath, Buffer.from(res.jpegBuffer)).catch(err => {
              logger.error('Failed to write event snapshot image:', err.message);
            });
            snapshotRelPath = fileName;
          } catch (err: any) {
            logger.error('Failed to prepare snapshot path:', err.message);
          }
        }

        event = EventRepository.create({
          cameraId: res.cameraId,
          label: primaryDetection.label,
          confidence: primaryDetection.confidence,
          snapshotPath: snapshotRelPath,
          timestamp: res.timestamp
        });

        logger.info(`[AI Alert] Cam: [${camName}] detected ${res.boxes.length} object(s) in ${res.durationMs}ms: ` +
          res.boxes.map(b => `${b.label.toUpperCase()} (${Math.round(b.confidence * 100)}%)`).join(', ')
        );
      }
    }

    // Always broadcast detection event via EventEmitter for WebSocket clients (boxes live, event on alert)
    this.emit('detectionEvent', {
      event,
      boxes: res.boxes || [],
      cameraId: res.cameraId
    });
  }

  /**
   * Gets or initializes the MotionFilter for a camera.
   */
  public getMotionFilter(camera: Camera): MotionFilter {
    let filter = this.motionFilters.get(camera.id);
    if (!filter) {
      const sensitivity = this.settingsService.getAiMotionSensitivity();
      filter = new MotionFilter(
        SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH,
        SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT,
        sensitivity,
        15 // pixelThreshold 15 for human movement
      );
      if (camera.roi_config) {
        try {
          const parsed = typeof camera.roi_config === 'string' ? JSON.parse(camera.roi_config) : camera.roi_config;
          filter.setROIConfig(parsed);
        } catch (e) {
          // Ignore invalid json
        }
      }
      this.motionFilters.set(camera.id, filter);
    }
    return filter;
  }

  /**
   * Updates ROI configuration for a specific camera.
   */
  public updateCameraROI(cameraId: string, roiConfig: ROIConfig | null): void {
    const filter = this.motionFilters.get(cameraId);
    if (filter) {
      filter.setROIConfig(roiConfig);
    }
  }

  /**
   * Hot-reloads the ONNX model path across the worker thread.
   */
  public reloadModel(modelPath: string): void {
    if (this.worker) {
      this.worker.postMessage({
        type: 'RELOAD_MODEL',
        modelPath: sanitizePath(modelPath)
      });
    }
  }

  /**
   * Evaluates Stage 1 micro-frame and triggers Stage 2 burst ONNX if motion is detected.
   */
  public handleStage1Frame(
    camera: Camera,
    microFrame: Buffer | Uint8Array,
    isRgb: boolean = false
  ): { hasMotion: boolean; score: number } {
    const filter = this.getMotionFilter(camera);
    const result = filter.processFrame(microFrame, isRgb);

    if (result.hasMotion) {
      this.lastMotionTime.set(camera.id, Date.now());
      this.emit('motionDetected', { cameraId: camera.id, score: result.score });
      logger.info(`[Stage1-Motion] Cam: [${camera.name}] (${camera.id}) motion triggered (score: ${result.score.toFixed(2)}%) -> Dispatched AI burst`);
    }

    return result;
  }

  /**
   * Checks if camera is in active motion burst window adapted to LoadGovernor cooldown.
   */
  public isCameraInBurstWindow(cameraId: string): boolean {
    const lastTime = this.lastMotionTime.get(cameraId);
    if (!lastTime) return false;
    const cooldownMs = this.loadGovernor.getBurstCooldownMs();
    return (Date.now() - lastTime) <= cooldownMs;
  }

  /**
   * Dispatches high-res frame to Stage 2 ONNX worker thread.
   * Uses per-camera locking and safe message passing without ArrayBuffer detaching.
   */
  public dispatchStage2Inference(
    cameraId: string,
    frameBuffer: Buffer,
    width: number,
    height: number
  ): void {
    const now = Date.now();

    // Thermal safety gate: if STB CPU is overheating (>82°C), temporarily drop inference to prevent shutdown
    if (this.loadGovernor.isEmergencyCoolingActive()) {
      return;
    }

    // Per-camera gate: skip if this specific camera is already inferring
    if (this.inferringCameras.has(cameraId)) {
      const startTime = this.inferenceStartTimes.get(cameraId) || 0;
      if (now - startTime > 5000) {
        // Inference took longer than 5s (hung worker or dropped message) - force release lock
        logger.warn(`Inference lock timeout (>5s) on cam [${cameraId}] - force unlocking`);
        this.inferringCameras.delete(cameraId);
        this.inferenceStartTimes.delete(cameraId);
      } else {
        return; // Non-blocking drop — this camera's previous inference hasn't finished
      }
    }

    // Per-camera throttle: minimum 250ms between inferences for same camera
    const lastTime = this.lastInferencePerCamera.get(cameraId) || 0;
    if (now - lastTime < PER_CAMERA_THROTTLE_MS) {
      return; // Too soon for this camera
    }

    // Global gate: worker must be ready
    if (!this.isWorkerReady || !this.worker) {
      return;
    }

    // Lock this camera
    this.inferringCameras.add(cameraId);
    this.inferenceStartTimes.set(cameraId, now);
    this.lastInferencePerCamera.set(cameraId, now);

    const timestamp = new Date().toISOString();
    const confidenceThreshold = this.settingsService.getAiConfidenceThreshold();
    const iouThreshold = this.settingsService.getAiIouThreshold();
    const targetClasses = this.settingsService.getAiTargetClasses();

    const msg = {
      type: 'INFER',
      cameraId,
      timestamp,
      frameBuffer,
      width,
      height,
      confidenceThreshold,
      iouThreshold,
      targetClasses
    };

    // Safe message dispatch without ArrayBuffer transfer list to prevent multi-camera buffer detachment
    this.worker.postMessage(msg);
  }
}
