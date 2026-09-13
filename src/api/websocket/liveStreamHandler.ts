/**
 * @file liveStreamHandler.ts
 * @description Fastify WebSocket route handler piping live fMP4 video fragments directly to browser HTML5 MediaSource clients.
 * @functions registerLiveStreamWs
 * @dependencies fastify, StreamManager
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { StreamManager } from '../../core/StreamManager';
import { createLogger } from '../../utils/logger';

const logger = createLogger('LiveStreamWS');

export async function registerLiveStreamWs(server: FastifyInstance): Promise<void> {
  const streamManager = StreamManager.getInstance();

  server.get('/ws/live/:cameraId', { websocket: true }, (socket: WebSocket, req: any) => {
    const cameraId = req.params.cameraId;
    logger.info(`Incoming WebSocket stream request for camera: ${cameraId}`);

    streamManager.registerLiveClient(cameraId, socket);
  });
}
