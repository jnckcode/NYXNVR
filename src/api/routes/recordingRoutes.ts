/**
 * @file recordingRoutes.ts
 * @description Fastify HTTP routes for listing, downloading, and streaming segmented MP4 video files with Range support.
 * @functions registerRecordingRoutes
 * @dependencies fastify, fs, path, RecordingRepository, pathSanitizer
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import { RecordingRepository } from '../../db/recordingRepository';
import { sanitizePath } from '../../utils/pathSanitizer';

export async function registerRecordingRoutes(server: FastifyInstance): Promise<void> {
  // Query filtered recordings
  server.get('/api/v1/recordings', async (req: FastifyRequest<{
    Querystring: {
      cameraId?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    }
  }>, reply: FastifyReply) => {
    const filter = {
      cameraId: req.query.cameraId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0
    };

    const result = RecordingRepository.getFiltered(filter);
    return reply.send({
      success: true,
      total: result.total,
      recordings: result.recordings
    });
  });

  // Stream / Download MP4 recording file with HTTP 206 Partial Content Range support
  server.get('/api/v1/recordings/file/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const recording = RecordingRepository.getById(req.params.id);
    if (!recording) {
      return reply.code(404).send({ success: false, error: 'Recording segment not found' });
    }

    const filePath = sanitizePath(recording.file_path);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ success: false, error: 'Video file missing on storage drive' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', chunksize)
        .header('Content-Type', 'video/mp4')
        .send(stream);
    } else {
      return reply
        .header('Content-Length', fileSize)
        .header('Content-Type', 'video/mp4')
        .header('Accept-Ranges', 'bytes')
        .send(fs.createReadStream(filePath));
    }
  });

  // Delete recording
  server.delete('/api/v1/recordings/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const recording = RecordingRepository.getById(req.params.id);
    if (!recording) {
      return reply.code(404).send({ success: false, error: 'Recording not found' });
    }

    try {
      if (fs.existsSync(recording.file_path)) {
        fs.unlinkSync(recording.file_path);
      }
    } catch (e) {
      // Ignore
    }

    RecordingRepository.deleteById(req.params.id);
    return reply.send({ success: true, message: 'Recording deleted successfully' });
  });
}
