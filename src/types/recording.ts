/**
 * @file recording.ts
 * @description Type definitions for MP4 video recording chunks, retention policies, and segment metadata.
 * @functions RecordingSegment, RecordingFilter
 * @dependencies none
 */

export interface RecordingSegment {
  id: string;
  camera_id: string;
  file_path: string;
  file_size: number;
  start_time: string;
  end_time: string;
}

export interface RecordingFilter {
  cameraId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}
