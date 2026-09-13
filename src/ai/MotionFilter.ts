/**
 * @file MotionFilter.ts
 * @description Stage 1 Motion Detection Engine performing micro-scale (160x120) pixel differencing with ROI polygon masking.
 * @functions processFrame, setROIConfig, reset, isPointInPolygon
 * @dependencies types/camera, types/event, constants, logger
 */

import { ROIConfig, ROIPoint } from '../types/camera';
import { SYSTEM_CONSTANTS } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('MotionFilter');

export class MotionFilter {
  private width: number;
  private height: number;
  private previousFrame: Uint8Array | null = null;
  private roiConfig: ROIConfig | null = null;
  private roiMask: Uint8Array | null = null;
  private thresholdPercent: number;
  private pixelThreshold: number; // minimum brightness delta to count as changed pixel

  constructor(
    width: number = SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH,
    height: number = SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT,
    thresholdPercent: number = SYSTEM_CONSTANTS.STAGE1_MOTION_THRESHOLD_PERCENT,
    pixelThreshold: number = 14
  ) {
    this.width = width;
    this.height = height;
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
   * Generates a 1D binary mask array for 160x120 grid based on normalized ROI polygons.
   */
  private generateRoiMask(): Uint8Array | null {
    if (!this.roiConfig || !this.roiConfig.enabled || !this.roiConfig.polygons || this.roiConfig.polygons.length === 0) {
      return null;
    }

    const mask = new Uint8Array(this.width * this.height);
    let totalActivePixels = 0;

    for (let y = 0; y < this.height; y++) {
      const normalizedY = y / this.height;
      for (let x = 0; x < this.width; x++) {
        const normalizedX = x / this.width;
        const point: ROIPoint = { x: normalizedX, y: normalizedY };

        let insideAny = false;
        for (const polygon of this.roiConfig.polygons) {
          if (this.isPointInPolygon(point, polygon)) {
            insideAny = true;
            break;
          }
        }

        const idx = y * this.width + x;
        mask[idx] = insideAny ? 1 : 0;
        if (insideAny) totalActivePixels++;
      }
    }

    logger.debug(`ROI Mask created with ${totalActivePixels}/${this.width * this.height} active pixels.`);
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
   * Processes a raw RGB/Grayscale frame buffer (160x120) and returns motion metrics.
   * @param rawBuffer Uint8Array or Buffer of raw grayscale or RGB24 frame data.
   */
  public processFrame(rawBuffer: Buffer | Uint8Array, isRgb: boolean = false): { hasMotion: boolean; score: number } {
    const totalPixels = this.width * this.height;
    const currentGrayscale = new Uint8Array(totalPixels);

    // Convert to grayscale if RGB
    if (isRgb) {
      for (let i = 0, j = 0; i < totalPixels; i++, j += 3) {
        // Fast luminance approximation: 0.299R + 0.587G + 0.114B ≈ (R*77 + G*150 + B*29) >> 8
        currentGrayscale[i] = (rawBuffer[j] * 77 + rawBuffer[j + 1] * 150 + rawBuffer[j + 2] * 29) >> 8;
      }
    } else {
      currentGrayscale.set(rawBuffer.subarray(0, totalPixels));
    }

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
