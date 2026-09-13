/**
 * @file MotionFilter.ts
 * @description Stage 1 Motion Detection Engine with internal downscale optimization.
 * 
 * Accepts full-resolution frames (640×360 RGB24) from FFmpeg pipe:3, internally
 * downscales to 160×120 grayscale for ultra-fast pixel differencing, then applies
 * ROI polygon masking.
 * 
 * Performance: 19,200 pixel comparisons instead of 230,400 = 12× faster per frame.
 * 
 * @functions processFrame, setROIConfig, reset, isPointInPolygon
 * @dependencies types/camera, constants, logger
 */

import { ROIConfig, ROIPoint } from '../types/camera';
import { SYSTEM_CONSTANTS } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('MotionFilter');

export class MotionFilter {
  /** Input frame dimensions (from FFmpeg pipe:3) */
  private inputWidth: number;
  private inputHeight: number;

  /** Internal motion detection dimensions (downscaled for speed) */
  private detectWidth: number;
  private detectHeight: number;

  private previousFrame: Uint8Array | null = null;
  private roiConfig: ROIConfig | null = null;
  private roiMask: Uint8Array | null = null;
  private thresholdPercent: number;
  private pixelThreshold: number;

  constructor(
    inputWidth: number = SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH,
    inputHeight: number = SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT,
    thresholdPercent: number = SYSTEM_CONSTANTS.STAGE1_MOTION_THRESHOLD_PERCENT,
    pixelThreshold: number = 14
  ) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    this.detectWidth = SYSTEM_CONSTANTS.MOTION_DETECT_WIDTH;
    this.detectHeight = SYSTEM_CONSTANTS.MOTION_DETECT_HEIGHT;
    this.thresholdPercent = thresholdPercent;
    this.pixelThreshold = pixelThreshold;
  }

  /**
   * Dynamically adjusts motion detection sensitivity.
   */
  public setSensitivity(thresholdPercent: number, pixelThreshold: number = 15): void {
    this.thresholdPercent = thresholdPercent;
    this.pixelThreshold = pixelThreshold;
  }

  /**
   * Sets or updates the ROI polygon mask configuration.
   * Mask is generated at detectWidth×detectHeight resolution.
   */
  public setROIConfig(config: ROIConfig | null): void {
    this.roiConfig = config;
    this.roiMask = this.generateRoiMask();
  }

  /**
   * Clears previous frame memory.
   */
  public reset(): void {
    this.previousFrame = null;
  }

  /**
   * Generates a 1D binary mask at detect resolution based on normalized ROI polygons.
   */
  private generateRoiMask(): Uint8Array | null {
    if (!this.roiConfig || !this.roiConfig.enabled || !this.roiConfig.polygons || this.roiConfig.polygons.length === 0) {
      return null;
    }

    const w = this.detectWidth;
    const h = this.detectHeight;
    const mask = new Uint8Array(w * h);
    let totalActivePixels = 0;

    for (let y = 0; y < h; y++) {
      const normalizedY = y / h;
      for (let x = 0; x < w; x++) {
        const normalizedX = x / w;
        const point: ROIPoint = { x: normalizedX, y: normalizedY };

        let insideAny = false;
        for (const polygon of this.roiConfig.polygons) {
          if (this.isPointInPolygon(point, polygon)) {
            insideAny = true;
            break;
          }
        }

        const idx = y * w + x;
        mask[idx] = insideAny ? 1 : 0;
        if (insideAny) totalActivePixels++;
      }
    }

    logger.debug(`ROI Mask created at ${w}×${h} with ${totalActivePixels}/${w * h} active pixels.`);
    return mask;
  }

  /**
   * Ray-casting algorithm to test if a point is within a polygon.
   */
  private isPointInPolygon(point: ROIPoint, polygon: ROIPoint[]): boolean {
    if (polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;

      const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Downscales a full-resolution RGB24 frame to detect-resolution grayscale using nearest-neighbor sampling.
   * This is the core optimization: 640×360 RGB → 160×120 grayscale = 12× fewer pixels to diff.
   */
  private downscaleToGrayscale(rawBuffer: Buffer | Uint8Array, isRgb: boolean): Uint8Array {
    const dw = this.detectWidth;
    const dh = this.detectHeight;
    const iw = this.inputWidth;
    const ih = this.inputHeight;
    const result = new Uint8Array(dw * dh);

    // Calculate step ratios for nearest-neighbor downscale
    const xStep = iw / dw;
    const yStep = ih / dh;

    if (isRgb) {
      // RGB24 input: 3 bytes per pixel
      for (let dy = 0; dy < dh; dy++) {
        const srcY = Math.min(ih - 1, (dy * yStep) | 0);
        const srcRow = srcY * iw * 3;
        const dstRow = dy * dw;

        for (let dx = 0; dx < dw; dx++) {
          const srcX = Math.min(iw - 1, (dx * xStep) | 0);
          const srcIdx = srcRow + srcX * 3;

          // Fast luminance: (R*77 + G*150 + B*29) >> 8
          result[dstRow + dx] = (rawBuffer[srcIdx] * 77 + rawBuffer[srcIdx + 1] * 150 + rawBuffer[srcIdx + 2] * 29) >> 8;
        }
      }
    } else {
      // Grayscale input: 1 byte per pixel
      for (let dy = 0; dy < dh; dy++) {
        const srcY = Math.min(ih - 1, (dy * yStep) | 0);
        const srcRow = srcY * iw;
        const dstRow = dy * dw;

        for (let dx = 0; dx < dw; dx++) {
          const srcX = Math.min(iw - 1, (dx * xStep) | 0);
          result[dstRow + dx] = rawBuffer[srcRow + srcX];
        }
      }
    }

    return result;
  }

  /**
   * Processes a raw RGB/Grayscale frame and returns motion metrics.
   * Input: Full resolution frame from FFmpeg pipe:3 (e.g. 640×360 RGB24)
   * Internal: Downscaled to 160×120 grayscale for ultra-fast differencing
   */
  public processFrame(rawBuffer: Buffer | Uint8Array, isRgb: boolean = false): { hasMotion: boolean; score: number } {
    // Downscale input to detect resolution for fast pixel diffing
    const currentGrayscale = this.downscaleToGrayscale(rawBuffer, isRgb);
    const totalPixels = this.detectWidth * this.detectHeight;

    if (!this.previousFrame) {
      this.previousFrame = currentGrayscale;
      return { hasMotion: false, score: 0 };
    }

    let changedPixels = 0;
    let eligiblePixels = 0;
    const mask = this.roiMask;

    for (let i = 0; i < totalPixels; i++) {
      if (mask && mask[i] === 0) {
        continue; // Excluded by ROI mask
      }

      eligiblePixels++;
      const diff = Math.abs(currentGrayscale[i] - this.previousFrame[i]);
      if (diff >= this.pixelThreshold) {
        changedPixels++;
      }
    }

    // Save current frame as reference
    this.previousFrame = currentGrayscale;

    const baseCount = eligiblePixels > 0 ? eligiblePixels : totalPixels;
    const score = (changedPixels / baseCount) * 100;
    const hasMotion = score >= this.thresholdPercent;

    return {
      hasMotion,
      score: Math.round(score * 100) / 100
    };
  }
}
