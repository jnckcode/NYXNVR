/**
 * @file camera.ts
 * @description Type definitions for IP camera entities, stream states, and ROI configuration.
 * @functions Camera, CameraCreateInput, CameraUpdateInput, CameraStreamState, ROIPolygon
 * @dependencies none
 */

export interface ROIPoint {
  x: number; // 0.0 to 1.0 normalized
  y: number; // 0.0 to 1.0 normalized
}

export interface ROIConfig {
  enabled: boolean;
  polygons: ROIPoint[][];
}

export interface Camera {
  id: string;
  name: string;
  rtsp_url: string;
  enabled: number; // 1 = active, 0 = disabled
  ai_enabled: number; // 1 = AI detection on, 0 = off
  roi_config?: string | null; // JSON string of ROIConfig
  created_at?: string;
}

export interface CameraCreateInput {
  name: string;
  rtsp_url: string;
  enabled?: boolean;
  ai_enabled?: boolean;
  roi_config?: ROIConfig | string;
}

export interface CameraUpdateInput {
  name?: string;
  rtsp_url?: string;
  enabled?: boolean;
  ai_enabled?: boolean;
  roi_config?: ROIConfig | string;
}

export type StreamStatusType = 'connecting' | 'streaming' | 'reconnecting' | 'stopped' | 'error';

export interface CameraStreamState {
  cameraId: string;
  status: StreamStatusType;
  reconnectAttempts: number;
  lastFrameTimestamp?: number;
  lastError?: string;
  bytesReceived: number;
  activeClientsCount: number;
}
