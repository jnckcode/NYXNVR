/**
 * @file ONNXInferenceWorker.ts
 * @description Stage 2 ONNX Inference Engine executed inside a dedicated Node.js worker_thread for YOLOv8 object detection with Hot-Reload.
 * @functions loadSession, runInference, nonMaximumSuppression, preprocessFrame
 * @dependencies worker_threads, onnxruntime-node, COCO_CLASSES, TARGET_SECURITY_CLASSES
 */

import { parentPort, isMainThread } from 'worker_threads';
import fs from 'fs';
import jpeg from 'jpeg-js';
import { COCO_CLASSES, TARGET_SECURITY_CLASSES } from '../config/constants';

let ort: any = null;
let session: any = null;
let currentModelPath: string | null = null;
let isSessionLoading = false;
let sessionInputWidth = 640;
let sessionInputHeight = 640;

try {
  ort = require('onnxruntime-node');
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('[ONNXWorker] onnxruntime-node library not loaded:', msg);
}

interface WorkerMessage {
  type: 'INIT' | 'INFER' | 'RELOAD_MODEL';
  modelPath?: string;
  cameraId?: string;
  timestamp?: string;
  frameBuffer?: Buffer | Uint8Array;
  width?: number;
  height?: number;
  confidenceThreshold?: number;
  iouThreshold?: number;
  targetClasses?: string[];
}

/**
 * Loads or hot-reloads the YOLOv8 ONNX model session.
 * Enforces strict 1-thread allocation for STB HG680P (Cortex-A53) to eliminate CPU thermal runaway.
 */
async function loadModelSession(modelPath: string): Promise<boolean> {
  if (!ort) {
    console.warn('[ONNXWorker] Cannot load session: onnxruntime-node unavailable');
    return false;
  }

  if (!fs.existsSync(modelPath)) {
    console.warn(`[ONNXWorker] Model file does not exist at: ${modelPath}`);
    return false;
  }

  isSessionLoading = true;
  try {
    console.log(`[ONNXWorker] Loading YOLOv8 ONNX model from: ${modelPath}...`);
    
    // Strict single-thread budget per session (Tips 2 & Tips 3) to prevent multi-camera thread contention and thermal shutdowns
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: 'sequential'
    });

    // Detect model input dimensions
    sessionInputWidth = 640;
    sessionInputHeight = 640;
    
    const lowerPath = modelPath.toLowerCase();
    if (lowerPath.includes('416x256') || lowerPath.includes('416_256') || lowerPath.includes('416') || lowerPath.includes('256')) {
      sessionInputWidth = 416;
      sessionInputHeight = 256;
    } else if (lowerPath.includes('320')) {
      sessionInputWidth = 320;
      sessionInputHeight = 320;
    }

    currentModelPath = modelPath;
    console.log(`[ONNXWorker] Model session successfully loaded: ${modelPath} (Resolution: ${sessionInputWidth}x${sessionInputHeight}, Threads: 1)`);
    isSessionLoading = false;
    return true;
  } catch (err: any) {
    console.error(`[ONNXWorker] Failed to load ONNX model [${modelPath}]:`, err.message);
    isSessionLoading = false;
    return false;
  }
}

interface PreprocessedImage {
  tensor: any;
  padX: number;
  padY: number;
  nw: number;
  nh: number;
}

// Pre-allocated reusable float arrays indexed by "WxH" to avoid Garbage Collection churn on 2GB RAM STB
const cachedFloatMap: Map<string, Float32Array> = new Map();

function getCachedFloatBuffer(targetW: number, targetH: number): Float32Array {
  const key = `${targetW}x${targetH}`;
  let buf = cachedFloatMap.get(key);
  const requiredLen = 3 * targetW * targetH;
  if (!buf || buf.length !== requiredLen) {
    buf = new Float32Array(requiredLen);
    cachedFloatMap.set(key, buf);
  }
  return buf;
}

/**
 * Preprocesses RGB frame buffer with Letterboxing (preserves aspect ratio + 114 gray padding)
 * into normalized float32 tensor [1, 3, targetH, targetW].
 */
function preprocessFrame(
  rawBuffer: Buffer | Uint8Array,
  origWidth: number,
  origHeight: number,
  targetW: number = 640,
  targetH: number = 640
): PreprocessedImage {
  const scale = Math.min(targetW / origWidth, targetH / origHeight);
  const nw = Math.round(origWidth * scale);
  const nh = Math.round(origHeight * scale);
  const padX = Math.floor((targetW - nw) / 2);
  const padY = Math.floor((targetH - nh) / 2);

  const totalPixels = targetW * targetH;
  const channelGOffset = totalPixels;
  const channelBOffset = totalPixels * 2;
  const floatData = getCachedFloatBuffer(targetW, targetH);
  floatData.fill(114 / 255.0); // Reset padding with Standard YOLO 114 gray fill

  const isGrayscale = rawBuffer.length === origWidth * origHeight;

  if (isGrayscale) {
    // Fast path: Grayscale buffer (1 byte per pixel)
    for (let y = 0; y < nh; y++) {
      const srcY = Math.min(origHeight - 1, Math.floor(y / scale));
      const srcRowOffset = srcY * origWidth;
      const destRowOffset = (y + padY) * targetW + padX;

      for (let x = 0; x < nw; x++) {
        const srcX = Math.min(origWidth - 1, Math.floor(x / scale));
        const val = rawBuffer[srcRowOffset + srcX] / 255.0;
        const destIdx = destRowOffset + x;

        floatData[destIdx] = val; // Red
        floatData[channelGOffset + destIdx] = val; // Green
        floatData[channelBOffset + destIdx] = val; // Blue
      }
    }
  } else {
    // Standard RGB24 buffer (3 bytes per pixel)
    for (let y = 0; y < nh; y++) {
      const srcY = Math.min(origHeight - 1, Math.floor(y / scale));
      const srcRowOffset = srcY * origWidth * 3;
      const destRowOffset = (y + padY) * targetW + padX;

      for (let x = 0; x < nw; x++) {
        const srcX = Math.min(origWidth - 1, Math.floor(x / scale));
        const srcIdx = srcRowOffset + srcX * 3;
        const destIdx = destRowOffset + x;

        floatData[destIdx] = rawBuffer[srcIdx] / 255.0; // Red
        floatData[channelGOffset + destIdx] = rawBuffer[srcIdx + 1] / 255.0; // Green
        floatData[channelBOffset + destIdx] = rawBuffer[srcIdx + 2] / 255.0; // Blue
      }
    }
  }

  const tensor = new ort.Tensor('float32', floatData, [1, 3, targetH, targetW]);
  return { tensor, padX, padY, nw, nh };
}

/**
 * Parses YOLOv8 output tensor [1, 84, 8400] and applies Non-Maximum Suppression with unpadded letterbox coords.
 */
function parseYOLOOutput(
  outputTensor: any,
  padX: number,
  padY: number,
  nw: number,
  nh: number,
  confThresh: number = 0.25,
  iouThresh: number = 0.45,
  targetClasses?: string[]
): any[] {
  const data: Float32Array = outputTensor.data;
  const dims = outputTensor.dims; // [1, 84, 8400] or [1, 8400, 84]

  let isChannelsFirst = true;
  let numChannels = 84;
  let numBoxes = 8400;

  if (dims.length === 3) {
    if (dims[1] === 84) {
      numChannels = dims[1];
      numBoxes = dims[2];
      isChannelsFirst = true;
    } else {
      numBoxes = dims[1];
      numChannels = dims[2];
      isChannelsFirst = false;
    }
  }

  const candidateBoxes: any[] = [];
  const normalizedTargets = (targetClasses && targetClasses.length > 0 && !targetClasses.includes('all'))
    ? new Set(targetClasses.map(c => c.toLowerCase()))
    : null;

  for (let i = 0; i < numBoxes; i++) {
    let cx: number, cy: number, w: number, h: number;
    let maxScore = 0;
    let maxClassId = -1;

    if (isChannelsFirst) {
      cx = data[0 * numBoxes + i];
      cy = data[1 * numBoxes + i];
      w = data[2 * numBoxes + i];
      h = data[3 * numBoxes + i];

      for (let c = 0; c < 80; c++) {
        const score = data[(4 + c) * numBoxes + i];
        if (score > maxScore) {
          maxScore = score;
          maxClassId = c;
        }
      }
    } else {
      const offset = i * numChannels;
      cx = data[offset + 0];
      cy = data[offset + 1];
      w = data[offset + 2];
      h = data[offset + 3];

      for (let c = 0; c < 80; c++) {
        const score = data[offset + 4 + c];
        if (score > maxScore) {
          maxScore = score;
          maxClassId = c;
        }
      }
    }

    if (maxScore >= confThresh && maxClassId >= 0 && maxClassId < COCO_CLASSES.length) {
      const label = COCO_CLASSES[maxClassId];

      // Filter by target security / custom class set if specified
      if (normalizedTargets && !normalizedTargets.has(label.toLowerCase())) {
        continue;
      }

      // Convert letterboxed box to unpadded original image normalized coordinates (0.0 to 1.0)
      const rawX = (cx - w / 2 - padX) / nw;
      const rawY = (cy - h / 2 - padY) / nh;
      const rawW = w / nw;
      const rawH = h / nh;

      const normX = Math.max(0, Math.min(1, rawX));
      const normY = Math.max(0, Math.min(1, rawY));
      const normW = Math.max(0, Math.min(1 - normX, rawW));
      const normH = Math.max(0, Math.min(1 - normY, rawH));

      // Skip invalid or out-of-frame boxes
      if (normW <= 0 || normH <= 0) continue;

      candidateBoxes.push({
        x: normX,
        y: normY,
        width: normW,
        height: normH,
        label,
        confidence: Math.round(maxScore * 100) / 100
      });
    }
  }

  return nonMaximumSuppression(candidateBoxes, iouThresh);
}

/**
 * Calculates IoU and filters overlapping bounding boxes.
 */
function nonMaximumSuppression(boxes: any[], iouThresh: number): any[] {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const selected: any[] = [];

  for (const box of boxes) {
    let keep = true;
    for (const chosen of selected) {
      if (box.label === chosen.label) {
        const iou = calculateIoU(box, chosen);
        if (iou > iouThresh) {
          keep = false;
          break;
        }
      }
    }
    if (keep) {
      selected.push(box);
    }
  }

  return selected;
}

function calculateIoU(boxA: any, boxB: any): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const boxAArea = boxA.width * boxA.height;
  const boxBArea = boxB.width * boxB.height;
  const unionArea = boxAArea + boxBArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

// Sequential inference queue to strictly prevent multi-camera tensor collisions and race conditions
const inferQueue: WorkerMessage[] = [];
let isProcessingQueue = false;

async function processNextInQueue(): Promise<void> {
  if (isProcessingQueue || inferQueue.length === 0) return;
  isProcessingQueue = true;

  const msg = inferQueue.shift()!;
  try {
    const start = Date.now();

    if (!session || !ort || isSessionLoading) {
      parentPort?.postMessage({
        type: 'INFER_RESULT',
        cameraId: msg.cameraId,
        timestamp: msg.timestamp,
        boxes: [],
        durationMs: 0,
        status: 'MODEL_NOT_READY'
      });
      isProcessingQueue = false;
      setImmediate(processNextInQueue);
      return;
    }

    if (!msg.frameBuffer || !msg.width || !msg.height) {
      parentPort?.postMessage({
        type: 'INFER_RESULT',
        cameraId: msg.cameraId,
        timestamp: msg.timestamp,
        boxes: [],
        durationMs: 0,
        status: 'INVALID_INPUT'
      });
      isProcessingQueue = false;
      setImmediate(processNextInQueue);
      return;
    }

    const { tensor, padX, padY, nw, nh } = preprocessFrame(
      msg.frameBuffer,
      msg.width,
      msg.height,
      sessionInputWidth,
      sessionInputHeight
    );
    const feeds: Record<string, any> = {};
    feeds[session.inputNames[0]] = tensor;

    const results = await session.run(feeds);
    const outputTensor = results[session.outputNames[0]];

    const boxes = parseYOLOOutput(
      outputTensor,
      padX,
      padY,
      nw,
      nh,
      msg.confidenceThreshold ?? 0.25,
      msg.iouThreshold ?? 0.45,
      msg.targetClasses
    );

    const durationMs = Date.now() - start;

    let jpegBuffer: Uint8Array | null = null;
    if (boxes.length > 0 && msg.frameBuffer && msg.width && msg.height) {
      try {
        const rawRgb = msg.frameBuffer;
        const w = msg.width;
        const h = msg.height;
        const rgba = Buffer.alloc(w * h * 4);
        for (let i = 0, j = 0; i < rawRgb.length; i += 3, j += 4) {
          rgba[j] = rawRgb[i];
          rgba[j + 1] = rawRgb[i + 1];
          rgba[j + 2] = rawRgb[i + 2];
          rgba[j + 3] = 255;
        }
        jpegBuffer = jpeg.encode({ data: rgba, width: w, height: h }, 80).data;
      } catch (e: any) {
        console.warn('[ONNXWorker] JPEG snapshot encoding warning:', e.message);
      }
    }

    parentPort?.postMessage({
      type: 'INFER_RESULT',
      cameraId: msg.cameraId,
      timestamp: msg.timestamp,
      boxes,
      durationMs,
      status: 'SUCCESS',
      jpegBuffer
    });
  } catch (err: any) {
    parentPort?.postMessage({
      type: 'INFER_RESULT',
      cameraId: msg.cameraId,
      timestamp: msg.timestamp,
      boxes: [],
      durationMs: 0,
      status: 'ERROR',
      error: err.message
    });
  } finally {
    isProcessingQueue = false;
    if (inferQueue.length > 0) {
      setImmediate(processNextInQueue);
    }
  }
}

// Worker message dispatcher
if (!isMainThread && parentPort) {
  parentPort.on('message', async (msg: WorkerMessage) => {
    try {
      if (msg.type === 'INIT' || msg.type === 'RELOAD_MODEL') {
        if (msg.modelPath) {
          const success = await loadModelSession(msg.modelPath);
          parentPort?.postMessage({
            type: 'MODEL_LOADED',
            success,
            modelPath: msg.modelPath
          });
        }
      } else if (msg.type === 'INFER') {
        // Prevent queue unbounded growth — cap queue to max 4 pending frames across all cameras
        if (inferQueue.length >= 4) {
          inferQueue.shift(); // Drop oldest stale frame
        }
        inferQueue.push(msg);
        processNextInQueue();
      }
    } catch (err: any) {
      parentPort?.postMessage({
        type: 'INFER_RESULT',
        cameraId: msg.cameraId,
        timestamp: msg.timestamp,
        boxes: [],
        durationMs: 0,
        status: 'ERROR',
        error: err.message
      });
    }
  });
}
