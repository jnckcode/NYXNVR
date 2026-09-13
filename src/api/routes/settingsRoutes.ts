/**
 * @file settingsRoutes.ts
 * @description Fastify HTTP routes for managing dynamic system settings and querying disk status.
 * @functions registerSettingsRoutes
 * @dependencies fastify, SettingsService, types/settings
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SettingsService } from '../../core/SettingsService';
import { SystemSettingsMap } from '../../types/settings';

export async function registerSettingsRoutes(server: FastifyInstance): Promise<void> {
  const settingsService = SettingsService.getInstance();

  // Get current system settings + disk capacity metrics
  server.get('/api/v1/settings', async (_req: FastifyRequest, reply: FastifyReply) => {
    const settings = settingsService.getSettings();
    const disk = settingsService.getDiskInfo();
    return reply.send({
      success: true,
      settings,
      disk
    });
  });

  // Update dynamic settings
  server.put('/api/v1/settings', async (req: FastifyRequest<{ Body: Partial<SystemSettingsMap> }>, reply: FastifyReply) => {
    try {
      const updated = settingsService.updateSettings(req.body);
      const disk = settingsService.getDiskInfo();
      return reply.send({
        success: true,
        message: 'Settings updated successfully',
        settings: updated,
        disk
      });
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        error: err.message
      });
    }
  });

  // Get auto-delete retention policy status, stats, and oldest recording
  server.get('/api/v1/storage/retention-status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const { RetentionWorker } = await import('../../core/RetentionWorker');
    const retentionWorker = RetentionWorker.getInstance();
    const status = retentionWorker.getRetentionStatus();
    const disk = settingsService.getDiskInfo();

    return reply.send({
      success: true,
      status,
      disk
    });
  });

  // Manually trigger an immediate retention cleanup cycle
  server.post('/api/v1/storage/purge', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { RetentionWorker } = await import('../../core/RetentionWorker');
      const retentionWorker = RetentionWorker.getInstance();
      const result = await retentionWorker.executeRetentionCycle(true);
      const disk = settingsService.getDiskInfo();

      return reply.send({
        success: true,
        message: `Auto-purge complete: ${result.purgedByAge} recording(s) and ${result.purgedSnapshots} snapshot(s) purged (${result.freedHuman} freed).`,
        result,
        disk
      });
    } catch (err: any) {
      return reply.code(500).send({
        success: false,
        error: err.message
      });
    }
  });
}
