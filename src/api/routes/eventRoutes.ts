/**
 * @file eventRoutes.ts
 * @description Fastify HTTP routes for querying AI detection logs and serving snapshot images.
 * @functions registerEventRoutes
 * @dependencies fastify, fs, path, EventRepository, constants, pathSanitizer
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { EventRepository } from '../../db/eventRepository';
import { SYSTEM_CONSTANTS } from '../../config/constants';
import { sanitizePath, isSafeSubpath } from '../../utils/pathSanitizer';

export async function registerEventRoutes(server: FastifyInstance): Promise<void> {
  // Query filtered AI events
  server.get('/api/v1/events', async (req: FastifyRequest<{
    Querystring: {
      cameraId?: string;
      label?: string;
      startDate?: string;
      endDate?: string;
      minConfidence?: string;
      limit?: string;
      offset?: string;
    }
  }>, reply: FastifyReply) => {
    const filter = {
      cameraId: req.query.cameraId,
      label: req.query.label,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      minConfidence: req.query.minConfidence ? parseFloat(req.query.minConfidence) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0
    };

    const result = EventRepository.getFiltered(filter);
    return reply.send({
      success: true,
      total: result.total,
      events: result.events
    });
  });

  // Get recent 10 events
  server.get('/api/v1/events/recent', async (_req: FastifyRequest, reply: FastifyReply) => {
    const events = EventRepository.getRecent(10);
    return reply.send({
      success: true,
      events
    });
  });

  // Serve snapshot image
  server.get('/api/v1/snapshots/:filename', async (req: FastifyRequest<{ Params: { filename: string } }>, reply: FastifyReply) => {
    const snapDir = SYSTEM_CONSTANTS.DEFAULT_SNAPSHOT_PATH;
    const targetFile = sanitizePath(path.join(snapDir, path.basename(req.params.filename)));

    if (!isSafeSubpath(snapDir, targetFile) || !fs.existsSync(targetFile)) {
      return reply.code(404).send({ success: false, error: 'Snapshot not found' });
    }

    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(fs.createReadStream(targetFile));
  });
}
