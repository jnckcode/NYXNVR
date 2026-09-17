/**
 * @file StreamManager.ts
 * @description Single Ingestion - Multi Consumer RTSP Engine with stream health watchdog.
 * Manages single-connection FFmpeg processes, fMP4 WebSocket live streaming,
 * MP4 file segmentation, and Stage 1 motion frame extraction.
 * 
 * Anti-Freeze Architecture:
 * - Stream Health Watchdog: Periodic check kills frozen FFmpeg processes
 * - Low-latency FFmpeg flags: nobuffer + low_delay + short probe
 * - Fast reconnect: 2s → 5s → 10s max (capped for surveillance)
 * - Init segment reset on reconnect for clean MSE recovery
 * - Motion buffer cap to prevent unbounded memory growth
 * 
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
import { LoadGovernor } from './LoadGovernor';
import { AIAnalyticsEngine } from '../ai/AIAnalyticsEngine';
import { CameraRepository } from '../db/cameraRepository';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';
import { ensureDirExists } from '../utils/pathSanitizer';

const logger = createLogger('StreamManager');

/** How often the watchdog checks stream health (ms) */
const WATCHDOG_INTERVAL_MS = 5000;
/** If no data received for this long, stream is considered frozen (ms) */
const STREAM_STALE_THRESHOLD_MS = 12000;
/** Maximum motion buffer size before forced trim (bytes) - prevents memory leak */
const MAX_MOTION_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB cap

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
  private loadGovernor: LoadGovernor;
  private aiEngine: AIAnalyticsEngine;
  private watchdogTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
    this.storageManager = StorageManager.getInstance();
    this.settingsService = SettingsService.getInstance();
    this.loadGovernor = LoadGovernor.getInstance();
    this.aiEngine = AIAnalyticsEngine.getInstance();
  }

  public static getInstance(): StreamManager {
    if (!StreamManager.instance) {
      StreamManager.instance = new StreamManager();
    }
    return StreamManager.instance;
  }

  /**
   * Starts the stream health watchdog timer.
   * Periodically checks all active streams and force-kills frozen FFmpeg processes.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.checkStreamHealth();
    }, WATCHDOG_INTERVAL_MS);
    logger.info(`Stream health watchdog started (interval: ${WATCHDOG_INTERVAL_MS}ms, stale threshold: ${STREAM_STALE_THRESHOLD_MS}ms)`);
  }

  /**
   * Stops the watchdog timer (called when no streams are active).
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      logger.debug('Stream health watchdog stopped.');
    }
  }

  /**
   * Watchdog health check - iterates all streams, detects frozen ones, and force-restarts.
   */
  private checkStreamHealth(): void {
    const now = Date.now();
    for (const [cameraId, stream] of this.activeStreams) {
      // Only check streams that claim to be streaming or connecting
      if (stream.status !== 'streaming' && stream.status !== 'connecting') continue;

      const timeSinceLastFrame = now - stream.lastFrameTime;

      // For 'connecting' status, allow longer grace period (20s for initial handshake)
      const threshold = stream.status === 'connecting' ? 20000 : STREAM_STALE_THRESHOLD_MS;

      if (timeSinceLastFrame > threshold) {
        logger.warn(
          `[Watchdog] Camera [${stream.camera.name}] FROZEN - no data for ${(timeSinceLastFrame / 1000).toFixed(1)}s. Force-killing FFmpeg...`
        );

        // Force-kill the frozen FFmpeg process - handleStreamTermination will auto-reconnect
        if (stream.process) {
          try {
            stream.process.kill('SIGKILL');
          } catch (e) {
            // Process may already be dead
          }
          stream.process = null;
        }

        // Reset init segment so reconnect produces fresh MSE headers
        stream.initSegment = null;
        stream.headerBuffer = Buffer.alloc(0);
        stream.motionBuffer = Buffer.alloc(0);

        this.handleStreamTermination(stream);
      }
    }
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

    // Start watchdog if not already running
    this.startWatchdog();
  }

  /**
   * Spawns the FFmpeg multiplexing process for a camera.
   * Uses optimized low-latency flags to prevent stream freeze.
   */
  private spawnFfmpegProcess(stream: ActiveStream): void {
    const { camera } = stream;
    const recDir = this.storageManager.getCameraRecordingDir(camera.id);
    const segmentPattern = path.join(recDir, '%Y-%m-%d_%H-%M-%S.mp4').replace(/\\/g, '/');

    const isRtsp = camera.rtsp_url.startsWith('rtsp://') || camera.rtsp_url.startsWith('rtsps://');
    
    const inputArgs: string[] = [];
    if (isRtsp) {
      inputArgs.push(
        '-rtsp_transport', 'tcp',
        '-stimeout', '10000000',          // 10s TCP timeout (-stimeout in microseconds is universal for FFmpeg 4.x/5.x/6.x/7.x)
        '-fflags', '+genpts+discardcorrupt+nobuffer', // nobuffer for low-latency
        '-flags', 'low_delay',           // Minimize decode latency
        '-use_wallclock_as_timestamps', '1',
        '-analyzeduration', '2000000',   // 2s analyze (was 5s - faster stream start)
        '-probesize', '2000000',         // 2MB probe (was 5MB - faster initial connect)
        '-max_delay', '500000',          // 500ms demuxer jitter headroom
        '-reorder_queue_size', '16'      // Small reorder queue to reduce latency
      );
    } else {
      inputArgs.push('-re');
    }
    inputArgs.push('-i', camera.rtsp_url);

    const segmentDuration = SYSTEM_CONSTANTS.DEFAULT_SEGMENT_DURATION_SECONDS;

    const ffmpegArgs = [
      ...inputArgs,
      // Output 1: Segmented MP4 files (Storage Engine) - passthrough copy
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'segment',
      '-segment_time', String(segmentDuration),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      segmentPattern,

      // Output 2: Fragmented MP4 to stdout (pipe:1) for live WebSocket MSE
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration', '250000',        // Fragment every 250ms for ultra-smooth live delivery
      '-flush_packets', '1',
      'pipe:1'
    ];

    // Output 3: Stage 1 Motion Frames (only if AI enabled)
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

    logger.info(`Spawning FFmpeg for camera [${camera.name}] (${camera.id}) - AI: ${isAiEnabled ? 'ON' : 'OFF (Zero-Decode Passthrough)'}`);

    try {
      const stdioOptions: any = isAiEnabled
        ? ['ignore', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe', 'ignore'];

      const proc = spawn('ffmpeg', ffmpegArgs, {
        stdio: stdioOptions
      });

      stream.process = proc;
      stream.status = 'connecting';
      stream.lastFrameTime = Date.now(); // Reset watchdog timer on spawn
      stream.currentSegmentStartTime = Date.now();

      // Track recent stderr lines for diagnostic logging on failure
      const stderrRingBuffer: string[] = [];
      const MAX_STDERR_LINES = 20;

      // Handle Output 2: fMP4 Live Stream (stdout)
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          stream.bytesReceived += chunk.length;
          stream.lastFrameTime = Date.now();

          if (stream.status !== 'streaming') {
            stream.status = 'streaming';
            stream.reconnectAttempts = 0;
            logger.info(`Camera [${camera.name}] stream is LIVE.`);
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
                stream.headerBuffer = Buffer.alloc(0); // Free header accumulator
                if (remaining.length > 0) {
                  stream.lastFragment = remaining;
                  this.broadcastToClients(stream, remaining);
                }
                logger.debug(`Camera [${camera.name}] init segment captured (${stream.initSegment.length} bytes).`);
              }
            }
            return;
          }

          stream.lastFragment = chunk;
          this.broadcastToClients(stream, chunk);
        });
      }

      // Handle Output 3: Stage 1 Motion Frame Buffer (pipe:3)
      const motionStream = isAiEnabled && proc.stdio ? (proc.stdio[3] as any) : null;
      if (motionStream) {
        const frameSize = SYSTEM_CONSTANTS.STAGE1_FRAME_WIDTH * SYSTEM_CONSTANTS.STAGE1_FRAME_HEIGHT * 3;

        motionStream.on('data', (chunk: Buffer) => {
          // Guard: cap motion buffer to prevent unbounded memory growth
          if (stream.motionBuffer.length + chunk.length > MAX_MOTION_BUFFER_BYTES) {
            stream.motionBuffer = Buffer.alloc(0);
          }

          stream.motionBuffer = Buffer.concat([stream.motionBuffer, chunk]);

          while (stream.motionBuffer.length >= frameSize) {
            const frame = Buffer.from(stream.motionBuffer.subarray(0, frameSize));
            const remaining = stream.motionBuffer.subarray(frameSize);
            stream.motionBuffer = remaining.length > 0 ? Buffer.from(remaining) : Buffer.alloc(0);

            const motionRes = this.aiEngine.handleStage1Frame(stream.camera, frame, true);
            const inBurst = this.aiEngine.isCameraInBurstWindow(stream.camera.id);
            const isContinuous = this.settingsService.isContinuousAiEnabled();

            // Stage 2 YOLO only runs on genuine motion, active burst window, or explicit continuous AI
            if (stream.camera.ai_enabled === 1 && (motionRes.hasMotion || inBurst || isContinuous)) {
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

      // Handle stderr: segment indexing + error logging
      if (proc.stderr) {
        let lastSegmentFile: string | null = null;
        proc.stderr.on('data', (data: Buffer) => {
          const logMsg = data.toString();
          const lines = logMsg.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
          for (const line of lines) {
            stderrRingBuffer.push(line);
            if (stderrRingBuffer.length > MAX_STDERR_LINES) {
              stderrRingBuffer.shift();
            }
          }

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

          const lower = logMsg.toLowerCase();
          if (
            lower.includes('error') ||
            lower.includes('invalid') ||
            lower.includes('failed') ||
            lower.includes('refused') ||
            lower.includes('unauthorized') ||
            lower.includes('unrecognized') ||
            lower.includes('not found') ||
            lower.includes('denied')
          ) {
            logger.warn(`[FFmpeg:${camera.name}] ${logMsg.trim()}`);
          }
        });
      }

      proc.on('close', (code: number | null) => {
        if (code !== 0 && code !== null) {
          const details = stderrRingBuffer.slice(-5).join(' | ');
          logger.warn(`FFmpeg process for [${camera.name}] exited with code ${code}${details ? ` -> ${details}` : ''}`);
        } else {
          logger.debug(`FFmpeg process for [${camera.name}] closed cleanly.`);
        }
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
   * Handles unexpected stream termination with fast auto-recovery.
   * Reconnect backoff: 2s → 4s → 7s → 10s max (capped for surveillance use-case).
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

    // Reset MSE state for clean reconnect - clients will get fresh init segment
    stream.initSegment = null;
    stream.headerBuffer = Buffer.alloc(0);
    stream.motionBuffer = Buffer.alloc(0);

    // Fast surveillance-grade backoff: 2s → 4s → 7s → 10s max
    const delay = Math.min(
      10000,
      Math.max(2000, Math.round(2000 * Math.pow(1.5, Math.min(stream.reconnectAttempts - 1, 4))))
    );

    logger.warn(`Camera [${stream.camera.name}] reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${stream.reconnectAttempts})...`);
    this.emit('streamStatusChanged', { cameraId: stream.camera.id, status: 'reconnecting', attempts: stream.reconnectAttempts });

    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = setTimeout(() => {
      const updatedCam = CameraRepository.getById(stream.camera.id);
      if (updatedCam && updatedCam.enabled === 1) {
        stream.camera = updatedCam;
        this.spawnFfmpegProcess(stream);
      } else {
        this.activeStreams.delete(stream.camera.id);
        // Stop watchdog if no more streams
        if (this.activeStreams.size === 0) this.stopWatchdog();
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

    // Stop watchdog if no more active streams
    if (this.activeStreams.size === 0) this.stopWatchdog();
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
   * Skips clients whose WebSocket send buffer is backed up (prevents backpressure freeze).
   */
  private broadcastToClients(stream: ActiveStream, chunk: Buffer): void {
    for (const client of stream.clients) {
      if (client.readyState === WebSocket.OPEN) {
        // Skip clients with excessive send buffer backpressure (> 2MB queued)
        // This prevents one slow client from freezing the entire broadcast loop
        if ((client as any).bufferedAmount > 2 * 1024 * 1024) {
          continue;
        }
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

    // Send init segment immediately for instant MSE playback
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
