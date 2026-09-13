/**
 * @file StreamManager.ts
 * @description Single Ingestion - Multi Consumer RTSP Engine managing single-connection FFmpeg processes, fMP4 WebSocket live streaming, MP4 file segmentation, and Stage 1 motion frame extraction.
 * @functions startCameraStream, stopCameraStream, restartCameraStream, registerLiveClient, unregisterLiveClient, getStreamState
 * @dependencies child_process, fs, path, events, StorageManager, SettingsService, AIAnalyticsEngine, CameraRepository, logger
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { WebSocket } from 'ws';
import { Camera, CameraStreamState, StreamStatusType } from '../types/camera';
import { StorageManager } from './StorageManager';
import { SettingsService } from './SettingsService';
import { AIAnalyticsEngine } from '../ai/AIAnalyticsEngine';
import { CameraRepository } from '../db/cameraRepository';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';
import { ensureDirExists } from '../utils/pathSanitizer';

const logger = createLogger('StreamManager');

interface ActiveStream {
  camera: Camera;
  process: ChildProcess | null;
  status: StreamStatusType;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  initSegment: Buffer | null;
  headerBuffer: Buffer;
  lastFragment: Buffer | null;
  clients: Set<WebSocket>;
  motionBuffer: Buffer;
  bytesReceived: number;
  lastFrameTime: number;
  currentSegmentStartTime: number;
  lastPeriodicAiScan?: number;
}

export class StreamManager extends EventEmitter {
  private static instance: StreamManager;
  private activeStreams: Map<string, ActiveStream> = new Map();
  private storageManager: StorageManager;
  private settingsService: SettingsService;
  private aiEngine: AIAnalyticsEngine;

  private constructor() {
    super();
    this.storageManager = StorageManager.getInstance();
    this.settingsService = SettingsService.getInstance();
    this.aiEngine = AIAnalyticsEngine.getInstance();
  }

  public static getInstance(): StreamManager {
    if (!StreamManager.instance) {
      StreamManager.instance = new StreamManager();
    }
    return StreamManager.instance;
  }

  /**
   * Starts ingestion streams for all enabled cameras in the database.
   */
  public async startAllEnabledStreams(): Promise<void> {
    const cameras = CameraRepository.getEnabled();
    logger.info(`Starting streams for ${cameras.length} enabled cameras...`);
    for (const cam of cameras) {
      this.startCameraStream(cam);
    }
  }

  /**
   * Starts a single camera's FFmpeg ingestion pipeline.
   */
  public startCameraStream(camera: Camera): void {
    if (this.activeStreams.has(camera.id)) {
      const existing = this.activeStreams.get(camera.id)!;
      if (existing.status === 'streaming' || existing.status === 'connecting') {
        logger.debug(`Stream for camera [${camera.name}] (${camera.id}) already running.`);
        return;
      }
    }

    const recDir = this.storageManager.getCameraRecordingDir(camera.id);
    ensureDirExists(recDir);

    const activeStream: ActiveStream = {
      camera,
      process: null,
      status: 'connecting',
      reconnectAttempts: 0,
      reconnectTimer: null,
      initSegment: null,
      headerBuffer: Buffer.alloc(0),
      lastFragment: null,
      clients: new Set(),
      motionBuffer: Buffer.alloc(0),
      bytesReceived: 0,
      lastFrameTime: Date.now(),
      currentSegmentStartTime: Date.now()
    };

    this.activeStreams.set(camera.id, activeStream);
    this.spawnFfmpegProcess(activeStream);
  }

  /**
   * Spawns the FFmpeg multiplexing process for a camera.
   */
  private spawnFfmpegProcess(stream: ActiveStream): void {
    const { camera } = stream;
    const recDir = this.storageManager.getCameraRecordingDir(camera.id);
    const segmentPattern = path.join(recDir, '%Y-%m-%d_%H-%M-%S.mp4').replace(/\\/g, '/');

    // Build FFmpeg arguments for Single Ingestion - Multi Consumer:
    // Output 1: MP4 Segments directly to storage (passthrough -c:v copy)
    // Output 2: fMP4 over stdout (pipe:1) for live WebSocket MSE streaming
    // Output 3: Micro-scale 160x120 grayscale frames over fd 3 (pipe:3) for Stage 1 MotionFilter (ONLY IF AI ENABLED)
    const isRtsp = camera.rtsp_url.startsWith('rtsp://') || camera.rtsp_url.startsWith('rtsps://');
    
    const inputArgs: string[] = [];
    if (isRtsp) {
      inputArgs.push(
        '-rtsp_transport', 'tcp',
        '-rtsp_flags', 'prefer_tcp',
        '-timeout', '15000000',        // 15s TCP socket timeout for slow camera handshakes
        '-fflags', '+genpts+discardcorrupt',
        '-use_wallclock_as_timestamps', '1',
        '-analyzeduration', '5000000', // 5s analyze duration to reliably capture SPS/PPS keyframes
        '-probesize', '5000000',       // 5MB probe buffer
        '-max_delay', '500000'         // 500ms demuxer jitter headroom
      );
    } else {
      // Test video loop or HTTP stream
      inputArgs.push('-re');
    }
    inputArgs.push('-i', camera.rtsp_url);

    const segmentDuration = SYSTEM_CONSTANTS.DEFAULT_SEGMENT_DURATION_SECONDS;

    const ffmpegArgs = [
      ...inputArgs,
      // Output 1: Segmented MP4 files (Storage Engine)
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'segment',
      '-segment_time', String(segmentDuration),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      segmentPattern,

      // Output 2: Fragmented MP4 stream to stdout (pipe:1) for WebSocket MSE (Low-Latency zero-stutter)
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-flush_packets', '1',
      'pipe:1'
    ];

    // Output 3 is ONLY attached if camera.ai_enabled is 1.
    // When AI is OFF, FFmpeg runs in pure 100% remux passthrough (copy), saving 20-30% CPU per camera!
    const isAiEnabled = camera.ai_enabled === 1;
    if (isAiEnabled) {
      ffmpegArgs.push(
        '-map', '0:v:0',
        '-threads', '1',
        '-filter_threads', '1',
        '-vf', `fps=2,scale=${SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH}:${SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT}`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        'pipe:3'
      );
    }

    logger.info(`Spawning FFmpeg for camera [${camera.name}] (${camera.id}) - AI Mode: ${isAiEnabled ? 'ON (Stage 1 Pipe Active)' : 'OFF (Zero-Decode Passthrough)'}...`);

    try {
      // stdio: [0: stdin, 1: stdout fmp4, 2: stderr log, 3: pipe motion frames (if AI enabled)]
      const stdioOptions: any = isAiEnabled
        ? ['ignore', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe', 'ignore'];

      const proc = spawn('ffmpeg', ffmpegArgs, {
        stdio: stdioOptions
      });

      stream.process = proc;
      stream.status = 'connecting';
      stream.currentSegmentStartTime = Date.now();

      // Handle Output 2: fMP4 Live Stream (stdout)
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          stream.bytesReceived += chunk.length;
          stream.lastFrameTime = Date.now();

          if (stream.status !== 'streaming') {
            stream.status = 'streaming';
            stream.reconnectAttempts = 0;
            this.emit('streamStatusChanged', { cameraId: camera.id, status: 'streaming' });
          }

          // Accumulate and accurately extract initial MP4 header (ftyp + moov)
          if (!stream.initSegment) {
            stream.headerBuffer = Buffer.concat([stream.headerBuffer, chunk]);
            const moovIdx = stream.headerBuffer.indexOf('moov');
            if (moovIdx >= 4) {
              const moovSize = stream.headerBuffer.readUInt32BE(moovIdx - 4);
              const totalInitLen = moovIdx - 4 + moovSize;
              if (stream.headerBuffer.length >= totalInitLen) {
                stream.initSegment = Buffer.from(stream.headerBuffer.subarray(0, totalInitLen));
                const remaining = stream.headerBuffer.subarray(totalInitLen);
                stream.headerBuffer = Buffer.alloc(0);
                if (remaining.length > 0) {
                  stream.lastFragment = remaining;
                  this.broadcastToClients(stream, remaining);
                }
              }
            }
            return;
          }

          stream.lastFragment = chunk;
          this.broadcastToClients(stream, chunk);
        });
      }

      // Handle Output 3: Stage 1 Motion Frame Buffer (pipe:3) - only active if AI is enabled
      const motionStream = isAiEnabled && proc.stdio ? (proc.stdio[3] as any) : null;
      if (motionStream) {
        const frameSize = SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH * SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT * 3; // 320 * 240 * 3 = 230,400 bytes

        motionStream.on('data', (chunk: Buffer) => {
          stream.motionBuffer = Buffer.concat([stream.motionBuffer, chunk]);

          while (stream.motionBuffer.length >= frameSize) {
            const frame = stream.motionBuffer.subarray(0, frameSize);
            stream.motionBuffer = stream.motionBuffer.subarray(frameSize);

            // Pass to Stage 1 Motion Filter (use dynamic stream.camera config and isRgb=true)
            const motionRes = this.aiEngine.handleStage1Frame(stream.camera, frame, true);

            const now = Date.now();
            const lastScan = stream.lastPeriodicAiScan || 0;
            // Scan keyframe every 1.5s even without motion, so stationary objects (people standing/sitting) remain detected
            const isPeriodicDue = (now - lastScan >= SYSTEM_CONSTANTS.HEARTBEAT_AI_SCAN_INTERVAL_MS);
            const inBurst = this.aiEngine.isCameraInBurstWindow(stream.camera.id);
            const isContinuous = this.settingsService.isContinuousAiEnabled();

            // Trigger Stage 2 ONNX if: motion detected, active burst window, continuous AI mode, or periodic heartbeat due
            if (stream.camera.ai_enabled === 1 && (motionRes.hasMotion || inBurst || isContinuous || isPeriodicDue)) {
              if (motionRes.hasMotion || isPeriodicDue) {
                stream.lastPeriodicAiScan = now;
              }
              this.aiEngine.dispatchStage2Inference(
                stream.camera.id,
                frame,
                SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH,
                SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT
              );
            }
          }
        });
      }

      if (proc.stderr) {
        let lastSegmentFile: string | null = null;
        proc.stderr.on('data', (data: Buffer) => {
          const logMsg = data.toString();
          // Extract newly opened segment path and index previous segment without disk storms
          const match = logMsg.match(/Opening '([^']+)' for writing/);
          if (match && match[1]) {
            const newlyOpened = match[1];
            if (lastSegmentFile) {
              const now = new Date().toISOString();
              const startIso = stream.currentSegmentStartTime
                ? new Date(stream.currentSegmentStartTime).toISOString()
                : now;
              this.storageManager.indexRecordingSegment(camera.id, lastSegmentFile, startIso, now);
            }
            lastSegmentFile = newlyOpened;
            stream.currentSegmentStartTime = Date.now();
          }

          if (logMsg.includes('Error') || logMsg.includes('Invalid') || logMsg.includes('Failed') || logMsg.includes('Connection refused') || logMsg.includes('401 Unauthorized') || logMsg.includes('Unrecognized')) {
            logger.warn(`[FFmpeg:${camera.name}] ${logMsg.trim()}`);
          }
        });
      }

      proc.on('close', (code: number) => {
        logger.warn(`FFmpeg process for [${camera.name}] exited with code ${code}`);
        this.handleStreamTermination(stream);
      });

      proc.on('error', (err: Error) => {
        logger.error(`FFmpeg spawn error for [${camera.name}]:`, err.message);
        this.handleStreamTermination(stream);
      });
    } catch (err: any) {
      logger.error(`Exception launching FFmpeg for [${camera.name}]:`, err.message);
      this.handleStreamTermination(stream);
    }
  }

  /**
   * Extracts fMP4 initialization segment (ftyp + moov) from the beginning of the stream.
   */
  private extractInitSegment(chunk: Buffer): Buffer | null {
    // Look for 'moov' atom
    const moovIdx = chunk.indexOf('moov');
    if (moovIdx > 0) {
      // Find end of moov atom
      const moovSize = chunk.readUInt32BE(moovIdx - 4);
      const initLen = moovIdx - 4 + moovSize;
      if (chunk.length >= initLen) {
        return Buffer.from(chunk.subarray(0, initLen));
      }
    }
    return Buffer.from(chunk.subarray(0, Math.min(chunk.length, 4096)));
  }

  /**
   * Handles unexpected stream termination with exponential backoff auto-recovery.
   */
  private handleStreamTermination(stream: ActiveStream): void {
    if (stream.process) {
      try {
        stream.process.kill('SIGKILL');
      } catch (e) {
        // Ignore
      }
      stream.process = null;
    }

    // If stream was manually stopped, do not auto-reconnect
    if (stream.status === 'stopped') {
      return;
    }

    stream.status = 'reconnecting';
    stream.reconnectAttempts++;

    // Exponential backoff: 3s -> 6s -> 11s -> 20s -> 35s -> max 60s
    const delay = Math.min(
      60000,
      Math.max(3000, Math.round(3000 * Math.pow(1.8, Math.min(stream.reconnectAttempts - 1, 6))))
    );

    logger.warn(`Camera [${stream.camera.name}] stream offline/dropped. Backoff reconnect in ${(delay / 1000).toFixed(1)}s (Attempt #${stream.reconnectAttempts})...`);
    this.emit('streamStatusChanged', { cameraId: stream.camera.id, status: 'reconnecting', attempts: stream.reconnectAttempts });

    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = setTimeout(() => {
      // Re-fetch camera details to ensure URL is fresh
      const updatedCam = CameraRepository.getById(stream.camera.id);
      if (updatedCam && updatedCam.enabled === 1) {
        stream.camera = updatedCam;
        this.spawnFfmpegProcess(stream);
      } else {
        this.activeStreams.delete(stream.camera.id);
      }
    }, delay);
  }

  /**
   * Stops ingestion stream for a specific camera.
   */
  public stopCameraStream(cameraId: string): void {
    const stream = this.activeStreams.get(cameraId);
    if (!stream) return;

    logger.info(`Stopping stream for camera ${cameraId}...`);
    stream.status = 'stopped';

    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
    }

    if (stream.process) {
      try {
        stream.process.kill('SIGTERM');
      } catch (e) {
        // Ignore
      }
      stream.process = null;
    }

    // Close connected WebSockets
    for (const ws of stream.clients) {
      try {
        ws.close();
      } catch (e) {
        // Ignore
      }
    }
    stream.clients.clear();

    this.activeStreams.delete(cameraId);
    this.emit('streamStatusChanged', { cameraId, status: 'stopped' });
  }

  /**
   * Updates camera configuration for an active in-memory stream without restarting FFmpeg.
   */
  public updateCameraConfig(camera: Camera): void {
    const stream = this.activeStreams.get(camera.id);
    if (stream) {
      const prevAiEnabled = stream.camera.ai_enabled;
      stream.camera = camera;
      logger.info(`Updated in-memory config for camera [${camera.name}] (AI: ${camera.ai_enabled ? 'ON' : 'OFF'}).`);

      // If AI state toggled, restart stream so FFmpeg attaches or detaches the Stage 1 decode pipe
      if (prevAiEnabled !== camera.ai_enabled && stream.status === 'streaming') {
        logger.info(`Restarting FFmpeg for camera [${camera.name}] to update AI pipeline...`);
        this.restartCameraStream(camera);
      }
    }
  }

  /**
   * Restarts an active stream (e.g. after camera URL edit or path relocation).
   */
  public restartCameraStream(camera: Camera): void {
    this.stopCameraStream(camera.id);
    setTimeout(() => {
      if (camera.enabled === 1) {
        this.startCameraStream(camera);
      }
    }, 1000);
  }

  /**
   * Broadcasts binary fMP4 chunk to all active WebSocket clients connected to this camera.
   */
  private broadcastToClients(stream: ActiveStream, chunk: Buffer): void {
    for (const client of stream.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(chunk);
        } catch (err) {
          // Ignore socket send error
        }
      }
    }
  }

  /**
   * Registers a new live WebSocket client to receive fMP4 chunks.
   */
  public registerLiveClient(cameraId: string, ws: WebSocket): void {
    let stream = this.activeStreams.get(cameraId);

    // If stream is not running yet, attempt to start it
    if (!stream) {
      const camera = CameraRepository.getById(cameraId);
      if (camera && camera.enabled === 1) {
        this.startCameraStream(camera);
        stream = this.activeStreams.get(cameraId);
      }
    }

    if (!stream) {
      logger.warn(`Cannot register WebSocket client: Camera [${cameraId}] not active.`);
      ws.close(1008, 'Camera stream inactive');
      return;
    }

    stream.clients.add(ws);
    logger.info(`Live WebSocket client connected to camera [${cameraId}]. Total clients: ${stream.clients.size}`);

    // If we have an initialization segment, send it immediately for instant MSE playback
    if (stream.initSegment && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(stream.initSegment);
      } catch (err) {
        // Ignore socket send error
      }
    }

    ws.on('close', () => {
      this.unregisterLiveClient(cameraId, ws);
    });

    ws.on('error', () => {
      this.unregisterLiveClient(cameraId, ws);
    });
  }

  /**
   * Unregisters a WebSocket client.
   */
  public unregisterLiveClient(cameraId: string, ws: WebSocket): void {
    const stream = this.activeStreams.get(cameraId);
    if (stream) {
      stream.clients.delete(ws);
      logger.debug(`Live WebSocket client disconnected from camera [${cameraId}]. Total clients: ${stream.clients.size}`);
    }
  }

  /**
   * Returns runtime state of a camera stream.
   */
  public getStreamState(cameraId: string): CameraStreamState {
    const stream = this.activeStreams.get(cameraId);
    if (!stream) {
      return {
        cameraId,
        status: 'stopped',
        reconnectAttempts: 0,
        bytesReceived: 0,
        activeClientsCount: 0
      };
    }

    return {
      cameraId,
      status: stream.status,
      reconnectAttempts: stream.reconnectAttempts,
      lastFrameTimestamp: stream.lastFrameTime,
      bytesReceived: stream.bytesReceived,
      activeClientsCount: stream.clients.size
    };
  }

  /**
   * Returns active streams count.
   */
  public getActiveStreamsCount(): number {
    let count = 0;
    for (const stream of this.activeStreams.values()) {
      if (stream.status === 'streaming') count++;
    }
    return count;
  }
}
