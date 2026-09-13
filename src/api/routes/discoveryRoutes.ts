/**
 * @file discoveryRoutes.ts
 * @description Fastify HTTP routes for network camera auto-discovery scan.
 * @functions registerDiscoveryRoutes
 * @dependencies fastify, DiscoveryService
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DiscoveryService } from '../../core/DiscoveryService';

export async function registerDiscoveryRoutes(server: FastifyInstance): Promise<void> {
  // Trigger network scan (ONVIF + subnet RTSP port scan)
  server.get('/api/v1/cameras/discover', async (req: FastifyRequest<{ Querystring: { timeout?: string } }>, reply: FastifyReply) => {
    const timeout = req.query.timeout ? parseInt(req.query.timeout, 10) : 3500;
    const result = await DiscoveryService.discoverCameras(timeout);
    return reply.send({
      success: true,
      ...result
    });
  });

  server.post('/api/v1/cameras/discover', async (req: FastifyRequest<{ Body: { timeout?: number } }>, reply: FastifyReply) => {
    const timeout = req.body?.timeout || 3500;
    const result = await DiscoveryService.discoverCameras(timeout);
    return reply.send({
      success: true,
      ...result
    });
  });
}
