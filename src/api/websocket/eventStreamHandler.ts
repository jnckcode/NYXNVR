/**
 * @file eventStreamHandler.ts
 * @description Fastify WebSocket route broadcasting real-time AI detection alerts, motion events, and stream status changes to dashboard clients.
 * @functions registerEventStreamWs
 * @dependencies fastify, ws, AIAnalyticsEngine, StreamManager
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { AIAnalyticsEngine } from '../../ai/AIAnalyticsEngine';
import { StreamManager } from '../../core/StreamManager';
import { LoadGovernor } from '../../core/LoadGovernor';
import { createLogger } from '../../utils/logger';

const logger = createLogger('EventStreamWS');

const connectedClients = new Set<WebSocket>();

export async function registerEventStreamWs(server: FastifyInstance): Promise<void> {
  const aiEngine = AIAnalyticsEngine.getInstance();
  const streamManager = StreamManager.getInstance();
  const loadGovernor = LoadGovernor.getInstance();

  // Listen to AI detection alerts (distinct security events) and broadcast to clients
  aiEngine.on('detectionEvent', (data: any) => {
    broadcast({
      type: 'DETECTION_EVENT',
      ...data
    });
  });

  // Listen to AI real-time bounding box overlay updates (live stream rendering)
  aiEngine.on('detectionOverlay', (data: any) => {
    broadcast({
      type: 'DETECTION_OVERLAY',
      ...data
    });
  });

  // Listen to Motion detected events
  aiEngine.on('motionDetected', (data: any) => {
    broadcast({
      type: 'MOTION_DETECTED',
      ...data
    });
  });

  // Listen to stream status changes
  streamManager.on('streamStatusChanged', (data: any) => {
    broadcast({
      type: 'STREAM_STATUS_CHANGED',
      ...data
    });
  });

  // Listen to Load Governor tier adjustments
  loadGovernor.on('tierChanged', (metrics: any) => {
    broadcast({
      type: 'GOVERNOR_TIER_CHANGED',
      metrics
    });
  });

  server.get('/ws/events', { websocket: true }, (socket: WebSocket) => {
    connectedClients.add(socket);
    logger.debug(`Dashboard WebSocket client connected. Active clients: ${connectedClients.size}`);

    socket.send(JSON.stringify({
      type: 'CONNECTED',
      message: 'Connected to Antigravity NVR Realtime Event Stream',
      timestamp: new Date().toISOString()
    }));

    socket.on('close', () => {
      connectedClients.delete(socket);
      logger.debug(`Dashboard WebSocket client disconnected. Active clients: ${connectedClients.size}`);
    });

    socket.on('error', () => {
      connectedClients.delete(socket);
    });
  });
}

function broadcast(payload: any): void {
  const msg = JSON.stringify(payload);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg);
      } catch (e) {
        // Ignore
      }
    }
  }
}
