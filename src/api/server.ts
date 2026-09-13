/**
 * @file server.ts
 * @description Fastify server bootstrapping, middleware registration (CORS, Multipart, WebSocket, Static files), and route wiring.
 * @functions createServer, startServer
 * @dependencies fastify, @fastify/cors, @fastify/multipart, @fastify/websocket, @fastify/static, path, routes
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';

import fs from 'fs';
import { registerCameraRoutes } from './routes/cameraRoutes';
import { registerSettingsRoutes } from './routes/settingsRoutes';
import { registerRecordingRoutes } from './routes/recordingRoutes';
import { registerEventRoutes } from './routes/eventRoutes';
import { registerDiscoveryRoutes } from './routes/discoveryRoutes';
import { registerSystemRoutes } from './routes/systemRoutes';
import { registerLiveStreamWs } from './websocket/liveStreamHandler';
import { registerEventStreamWs } from './websocket/eventStreamHandler';
import { createLogger } from '../utils/logger';
import { SYSTEM_CONSTANTS } from '../config/constants';
import { getAvailablePort } from '../utils/portFinder';

const logger = createLogger('Server');

export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false
  });

  // Register essential plugins
  await server.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });

  await server.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024 // 100MB max for ONNX models
    }
  });

  await server.register(websocket);

  // Serve static UI frontend with robust fallback path detection
  let publicPath = path.resolve(__dirname, '..', 'public');
  if (!fs.existsSync(path.join(publicPath, 'index.html'))) {
    const srcPublic = path.resolve(process.cwd(), 'src', 'public');
    if (fs.existsSync(path.join(srcPublic, 'index.html'))) {
      publicPath = srcPublic;
    } else {
      publicPath = path.resolve(__dirname, '..', '..', 'src', 'public');
    }
  }

  logger.info(`Serving static Web UI from: ${publicPath}`);

  await server.register(fastifyStatic, {
    root: publicPath,
    prefix: '/'
  });

  // Register REST Routes
  await registerCameraRoutes(server);
  await registerSettingsRoutes(server);
  await registerRecordingRoutes(server);
  await registerEventRoutes(server);
  await registerDiscoveryRoutes(server);
  await registerSystemRoutes(server);

  // Register WebSocket Handlers
  await registerLiveStreamWs(server);
  await registerEventStreamWs(server);

  // Fallback route: return index.html for UI SPA routes, or 404 JSON for /api and /ws
  server.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      return reply.code(404).send({
        success: false,
        error: 'Not Found',
        message: `Resource ${req.method}:${req.url} does not exist`,
        statusCode: 404
      });
    }
    return reply.sendFile('index.html');
  });

  return server;
}

export interface ServerStartResult {
  server: FastifyInstance;
  port: number;
  originalPort: number;
  portShifted: boolean;
}

export async function startServer(
  desiredPort: number = SYSTEM_CONSTANTS.DEFAULT_PORT,
  host: string = SYSTEM_CONSTANTS.DEFAULT_HOST
): Promise<ServerStartResult> {
  const { port: actualPort, changed } = await getAvailablePort(desiredPort, host);
  if (changed) {
    logger.warn(`[PORT RESOLVED] Requested port ${desiredPort} was unavailable. Bound to port ${actualPort} instead.`);
  }

  const server = await createServer();
  await server.listen({ port: actualPort, host });
  logger.info(`Antigravity NVR Web Server listening at http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);

  // Persist the active runtime port to a dotfile so external scripts or services can easily query it
  try {
    fs.writeFileSync(path.resolve(process.cwd(), '.runtime_port'), String(actualPort), 'utf-8');
  } catch {
    // Non-fatal if read-only filesystem
  }

  return {
    server,
    port: actualPort,
    originalPort: desiredPort,
    portShifted: changed
  };
}
