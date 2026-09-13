/**
 * @file discovery.ts
 * @description Type definitions for network IP camera auto-discovery (ONVIF & RTSP port scan).
 * @functions DiscoveredCamera, DiscoveryScanResult
 * @dependencies none
 */

export interface DiscoveredCamera {
  ip: string;
  port: number;
  protocol: 'ONVIF' | 'RTSP' | 'HTTP';
  name?: string;
  manufacturer?: string;
  model?: string;
  rtspUrl: string;
  xaddr?: string;
}

export interface DiscoveryScanResult {
  scanDurationMs: number;
  devicesFound: number;
  cameras: DiscoveredCamera[];
}
