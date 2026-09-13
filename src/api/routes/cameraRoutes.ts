/**
 * @file cameraRoutes.ts
 * @description Fastify HTTP routes for Camera CRUD operations, dynamic AI toggles, and ROI polygon configuration.
 * @functions registerCameraRoutes
 * @dependencies fastify, CameraRepository, StreamManager, AIAnalyticsEngine, types/camera
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CameraRepository } from '../../db/cameraRepository';
import { StreamManager } from '../../core/StreamManager';
import { AIAnalyticsEngine } from '../../ai/AIAnalyticsEngine';
import { CameraCreateInput, CameraUpdateInput, ROIConfig } from '../../types/camera';

export async function registerCameraRoutes(server: FastifyInstance): Promise<void> {
  const streamManager = StreamManager.getInstance();
  const aiEngine = AIAnalyticsEngine.getInstance();

  // List all cameras
  server.get('/api/v1/cameras', async (_req: FastifyRequest, reply: FastifyReply) => {
    const cameras = CameraRepository.getAll();
    const enriched = cameras.map(cam => {
      const state = streamManager.getStreamState(cam.id);
      return {
        ...cam,
        streamState: state
      };
    });
    return reply.send({ success: true, count: enriched.length, cameras: enriched });
  });

  // Get single camera by ID
  server.get('/api/v1/cameras/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const camera = CameraRepository.getById(req.params.id);
    if (!camera) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }
    const state = streamManager.getStreamState(camera.id);
    return reply.send({ success: true, camera: { ...camera, streamState: state } });
  });

  // Create new camera
  server.post('/api/v1/cameras', async (req: FastifyRequest<{ Body: CameraCreateInput }>, reply: FastifyReply) => {
    const { name, rtsp_url, enabled, ai_enabled, roi_config } = req.body;
    if (!name || !rtsp_url) {
      return reply.code(400).send({ success: false, error: 'Camera name and RTSP URL are required' });
    }

    const newCamera = CameraRepository.create({
      name,
      rtsp_url,
      enabled: enabled !== undefined ? enabled : true,
      ai_enabled: ai_enabled !== undefined ? ai_enabled : false,
      roi_config
    });

    if (newCamera.enabled === 1) {
      streamManager.startCameraStream(newCamera);
    }

    return reply.code(201).send({ success: true, camera: newCamera });
  });

  // Update existing camera
  server.put('/api/v1/cameras/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: CameraUpdateInput }>, reply: FastifyReply) => {
    const updated = CameraRepository.update(req.params.id, req.body);
    if (!updated) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }

    // Restart stream with new parameters if enabled
    if (updated.enabled === 1) {
      streamManager.restartCameraStream(updated);
    } else {
      streamManager.stopCameraStream(updated.id);
    }

    return reply.send({ success: true, camera: updated });
  });

  // Toggle camera enabled / disabled state
  server.patch('/api/v1/cameras/:id/toggle', async (req: FastifyRequest<{ Params: { id: string }; Body: { enabled: boolean } }>, reply: FastifyReply) => {
    const { enabled } = req.body;
    const updated = CameraRepository.toggleEnabled(req.params.id, !!enabled);
    if (!updated) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }

    if (updated.enabled === 1) {
      streamManager.startCameraStream(updated);
    } else {
      streamManager.stopCameraStream(updated.id);
    }

    return reply.send({ success: true, camera: updated });
  });

  // Toggle AI detection ON / OFF (without interrupting RTSP stream!)
  server.patch('/api/v1/cameras/:id/toggle-ai', async (req: FastifyRequest<{ Params: { id: string }; Body: { ai_enabled: boolean } }>, reply: FastifyReply) => {
    const { ai_enabled } = req.body;
    const updated = CameraRepository.toggleAI(req.params.id, !!ai_enabled);
    if (!updated) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }

    streamManager.updateCameraConfig(updated);
    return reply.send({ success: true, camera: updated });
  });

  // Update ROI configuration
  server.put('/api/v1/cameras/:id/roi', async (req: FastifyRequest<{ Params: { id: string }; Body: { roi_config: ROIConfig | null } }>, reply: FastifyReply) => {
    const updated = CameraRepository.updateROI(req.params.id, req.body.roi_config);
    if (!updated) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }

    aiEngine.updateCameraROI(req.params.id, req.body.roi_config);
    streamManager.updateCameraConfig(updated);
    return reply.send({ success: true, camera: updated });
  });

  // Delete camera
  server.delete('/api/v1/cameras/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    streamManager.stopCameraStream(req.params.id);
    const deleted = CameraRepository.delete(req.params.id);
    if (!deleted) {
      return reply.code(404).send({ success: false, error: 'Camera not found' });
    }
    return reply.send({ success: true, message: 'Camera deleted successfully' });
  });
}
