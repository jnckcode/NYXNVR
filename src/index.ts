/**
 * @file index.ts
 * @description Main application bootstrap entrypoint orchestrating database initialization, services startup, and graceful process termination.
 * @functions bootstrap, handleGracefulShutdown
 * @dependencies db/schema, core/SettingsService, core/StreamManager, core/RetentionWorker, core/StorageManager, api/server, utils/logger
 */

import { initSchema } from './db/schema';
import { closeDatabase } from './db/database';
import { SettingsService } from './core/SettingsService';
import { StorageManager } from './core/StorageManager';
import { RetentionWorker } from './core/RetentionWorker';
import { StreamManager } from './core/StreamManager';
import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { SYSTEM_CONSTANTS } from './config/constants';

const logger = createLogger('Bootstrap');

async function bootstrap(): Promise<void> {
  logger.info('====================================================');
  logger.info(`   ${SYSTEM_CONSTANTS.APP_NAME} v${SYSTEM_CONSTANTS.APP_VERSION} INITIALIZING`);
  logger.info('   Optimized: Lightweight | Stable | High Accuracy');
  logger.info('   Target Hardware: ARM64 STB HG680-P (RAM 2GB)');
  logger.info('====================================================');

  try {
    // 1. Initialize SQLite schema & default seed settings
    logger.info('1. Initializing SQLite Database (WAL Mode)...');
    initSchema();

    // 2. Initialize Core Services
    logger.info('2. Initializing Core Services & Storage Directories...');
    const settingsService = SettingsService.getInstance();
    const storageManager = StorageManager.getInstance();
    const retentionWorker = RetentionWorker.getInstance();
    const streamManager = StreamManager.getInstance();

    // 3. Start Background Retention Worker
    logger.info('3. Starting Storage Retention Worker...');
    retentionWorker.start();

    // 4. Start Fastify Web & WebSocket Server with Automatic Port Discovery
    const desiredPort = Number(process.env.PORT) || SYSTEM_CONSTANTS.DEFAULT_PORT;
    const host = process.env.HOST || SYSTEM_CONSTANTS.DEFAULT_HOST;
    logger.info(`4. Starting Fastify Web & WebSocket Server (desired port: ${desiredPort})...`);
    const { server, port: actualPort, portShifted } = await startServer(desiredPort, host);

    // 5. Ingest and start streams for all enabled cameras
    logger.info('5. Starting Single Ingestion streams for enabled cameras...');
    await streamManager.startAllEnabledStreams();

    logger.info('====================================================');
    logger.info(`   ${SYSTEM_CONSTANTS.APP_NAME} v${SYSTEM_CONSTANTS.APP_VERSION} IS RUNNING!`);
    logger.info(`   Dashboard: http://localhost:${actualPort}${portShifted ? ` (shifted from ${desiredPort})` : ''}`);
    logger.info('====================================================');

    // Handle process signals for safe teardown
    const shutdown = async (signal: string) => {
      logger.warn(`Received ${signal}. Initiating graceful shutdown...`);
      retentionWorker.stop();
      
      const cameras = require('./db/cameraRepository').CameraRepository.getAll();
      for (const cam of cameras) {
        streamManager.stopCameraStream(cam.id);
      }

      await server.close();
      closeDatabase();
      logger.info('Graceful shutdown complete. Process exiting.');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err: any) {
    logger.error('Fatal bootstrap error:', err);
    process.exit(1);
  }
}

bootstrap();
