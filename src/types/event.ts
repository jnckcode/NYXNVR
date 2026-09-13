/**
 * @file event.ts
 * @description Type definitions for AI detection events, bounding boxes, snapshots, and event filters.
 * @functions AIEvent, BoundingBox, DetectionResult, EventFilter
 * @dependencies none
 */

export interface BoundingBox {
  x: number; // Normalized 0..1 or pixel coord
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
}

export interface DetectionResult {
  cameraId: string;
  timestamp: string;
  boxes: BoundingBox[];
  snapshotBuffer?: Buffer;
  snapshotPath?: string;
  motionScore: number;
}

export interface AIEvent {
  id: string;
  camera_id: string;
  label: string;
  confidence: number;
  snapshot_path: string;
  timestamp: string;
}

export interface EventFilter {
  cameraId?: string;
  label?: string;
  startDate?: string;
  endDate?: string;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}
