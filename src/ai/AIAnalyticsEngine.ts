/**
 * @file AIAnalyticsEngine.ts
 * @description Dynamic Two-Stage AI Analytics Coordinator managing Stage 1 MotionFilter and Stage 2 ONNX Worker Thread with Hot-Reload.
 * @functions processStage1Frame, processStage2Inference, setCameraROI, toggleCameraAI, reloadModel
 * @dependencies worker_threads, events, fs, path, MotionFilter, SettingsService, EventRepository, CameraRepository, logger
 */

import EventEmitter from 'events';
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import jpeg from 'jpeg-js';
import { MotionFilter } from './MotionFilter';
import { SettingsService } from '../core/SettingsService';
import { EventRepository } from '../db/eventRepository';
import { CameraRepository } from '../db/cameraRepository';
import { ROIConfig, Camera } from '../types/camera';
import { BoundingBox, DetectionResult } from '../types/event';
import { ensureDirExists, sanitizePath } from '../utils/pathSanitizer';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';

const logger = createLogger('AIAnalyticsEngine');

export class AIAnalyticsEngine extends EventEmitter {
  private static instance: AIAnalyticsEngine;
  private settingsService: SettingsService;
  private worker: Worker | null = null;
  private motionFilters: Map<string, MotionFilter> = new Map();
  private lastMotionTime: Map<string, number> = new Map();
  private isWorkerReady: boolean = false;
  private isInferring: boolean = false;
  private lastInferenceTime: number = 0;
  private pendingInferences: Map<string, { frame: Buffer; width: number; height: number; timestamp: string }> = new Map();

  private constructor() {
    super();
    this.settingsService = SettingsService.getInstance();
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
   * Processes Stage 2 inference results, saves snapshots, and writes SQLite event records.
   */
  private handleInferenceResult(res: {
    cameraId: string;
    timestamp: string;
    boxes: BoundingBox[];
    durationMs: number;
    status: string;
  }): void {
    this.isInferring = false;
    this.lastInferenceTime = Date.now();

    if (!res.boxes || res.boxes.length === 0) {
      this.pendingInferences.delete(res.cameraId);
      return;
    }

    const cam = CameraRepository.getById(res.cameraId);
    const camName = cam ? cam.name : res.cameraId;

    logger.info(`[AI] Cam: [${camName}] detected ${res.boxes.length} object(s) in ${res.durationMs}ms: ` +
      res.boxes.map(b => `${b.label.toUpperCase()} (${Math.round(b.confidence * 100)}%)`).join(', ')
    );

    const pending = this.pendingInferences.get(res.cameraId);
    let snapshotRelPath = '';

    if (pending) {
      try {
        const snapDir = SYSTEM_CONSTANTS.DEFAULT_SNAPSHOT_PATH;
        ensureDirExists(snapDir);
        const fileName = `${res.cameraId}_${Date.now()}.jpg`;
        const fullSnapPath = path.join(snapDir, fileName);

        // Convert raw RGB24 buffer to RGBA and encode as real JPEG image
        const rawRgb = pending.frame;
        const w = pending.width;
        const h = pending.height;
        const rgba = Buffer.alloc(w * h * 4);
        for (let i = 0, j = 0; i < rawRgb.length; i += 3, j += 4) {
          rgba[j] = rawRgb[i];
          rgba[j + 1] = rawRgb[i + 1];
          rgba[j + 2] = rawRgb[i + 2];
          rgba[j + 3] = 255;
        }
        const jpegData = jpeg.encode({ data: rgba, width: w, height: h }, 80).data;
        fs.writeFileSync(fullSnapPath, jpegData);
        snapshotRelPath = fileName;
      } catch (err: any) {
        logger.error('Failed to save event snapshot image:', err.message);
      } finally {
        this.pendingInferences.delete(res.cameraId);
      }
    }

    // Persist highest confidence detection to SQLite
    const primaryDetection = res.boxes[0];
    const event = EventRepository.create({
      cameraId: res.cameraId,
      label: primaryDetection.label,
      confidence: primaryDetection.confidence,
      snapshotPath: snapshotRelPath,
      timestamp: res.timestamp
    });

    // Broadcast detection event via EventEmitter for WebSockets
    this.emit('detectionEvent', {
      event,
      boxes: res.boxes,
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
   * Evaluates Stage 1 micro-frame (160x120) and triggers Stage 2 burst ONNX if motion is detected.
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
   * Checks if camera is in active motion burst window.
   */
  public isCameraInBurstWindow(cameraId: string): boolean {
    const lastTime = this.lastMotionTime.get(cameraId);
    if (!lastTime) return false;
    return (Date.now() - lastTime) <= SYSTEM_CONSTANTS.MOTION_COOLDOWN_MS;
  }

  /**
   * Dispatches high-res frame to Stage 2 ONNX worker thread during motion burst.
   */
  public dispatchStage2Inference(
    cameraId: string,
    frameBuffer: Buffer,
    width: number,
    height: number
  ): void {
    // Drop frame if inference is currently in progress, or within throttle window (max 3-4 FPS burst)
    const now = Date.now();
    if (!this.isWorkerReady || !this.worker || this.isInferring || (now - this.lastInferenceTime < 250)) {
      return; // Non-blocking drop frame
    }

    this.isInferring = true;
    this.lastInferenceTime = now;
    const timestamp = new Date().toISOString();
    this.pendingInferences.set(cameraId, {
      frame: frameBuffer,
      width,
      height,
      timestamp
    });

    const confidenceThreshold = this.settingsService.getAiConfidenceThreshold();
    const iouThreshold = this.settingsService.getAiIouThreshold();
    const targetClasses = this.settingsService.getAiTargetClasses();

    this.worker.postMessage({
      type: 'INFER',
      cameraId,
      timestamp,
      frameBuffer,
      width,
      height,
      confidenceThreshold,
      iouThreshold,
      targetClasses
    });
  }
}
