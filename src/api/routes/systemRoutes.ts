/**
 * @file systemRoutes.ts
 * @description Fastify HTTP routes for system hardware metrics, disk space metrics, and custom ONNX model file uploads with Hot-Reload.
 * @functions registerSystemRoutes
 * @dependencies fastify, fs, path, pipeline, getSystemMetrics, SettingsService, StreamManager, constants, pathSanitizer
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { getSystemMetrics } from '../../utils/metrics';
import { SettingsService } from '../../core/SettingsService';
import { StreamManager } from '../../core/StreamManager';
import { SYSTEM_CONSTANTS } from '../../config/constants';
import { ensureDirExists, sanitizePath } from '../../utils/pathSanitizer';

export async function registerSystemRoutes(server: FastifyInstance): Promise<void> {
  const settingsService = SettingsService.getInstance();
  const streamManager = StreamManager.getInstance();

  // Hardware metrics for ARM64 STB monitoring
  server.get('/api/v1/system/metrics', async (_req: FastifyRequest, reply: FastifyReply) => {
    const activeStreams = streamManager.getActiveStreamsCount();
    const metrics = getSystemMetrics(activeStreams, 1);
    return reply.send({
      success: true,
      metrics
    });
  });

  // Disk capacity & storage metrics
  server.get('/api/v1/system/disk', async (_req: FastifyRequest, reply: FastifyReply) => {
    const diskInfo = settingsService.getDiskInfo();
    return reply.send({
      success: true,
      disk: diskInfo
    });
  });

  // Upload custom ONNX model and trigger Hot-Reload
  server.post('/api/v1/models/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ success: false, error: 'No model file provided in multipart body' });
    }

    if (!data.filename.endsWith('.onnx')) {
      return reply.code(400).send({ success: false, error: 'Only .onnx model files are supported' });
    }

    const modelsDir = SYSTEM_CONSTANTS.DEFAULT_MODELS_DIR;
    ensureDirExists(modelsDir);

    const targetFileName = `${Date.now()}_${path.basename(data.filename)}`;
    const destinationPath = path.join(modelsDir, targetFileName);

    await pipeline(data.file, fs.createWriteStream(destinationPath));

    // Update dynamic settings to the new uploaded model -> triggers hot-reload
    settingsService.updateSettings({
      ai_model_path: destinationPath
    });

    return reply.send({
      success: true,
      message: 'ONNX model uploaded and hot-reloaded successfully',
      modelPath: destinationPath,
      fileName: targetFileName
    });
  });
}
