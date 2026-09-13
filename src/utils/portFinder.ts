/**
 * @file portFinder.ts
 * @description Utility for probing TCP port availability and automatically discovering free open ports.
 * @functions isPortAvailable, getAvailablePort
 * @dependencies net, logger
 */

import net from 'net';
import { createLogger } from './logger';

const logger = createLogger('PortFinder');

/**
 * Checks if a specific port is currently available on the given host.
 * @param port The TCP port to test.
 * @param host The host/interface to bind (defaults to '0.0.0.0').
 * @returns Promise resolving to true if available, false if in use or forbidden.
 */
export function isPortAvailable(port: number, host: string = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(false);
      } else {
        // Any other network error also treat as unavailable
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });

    server.listen(port, host);
  });
}

/**
 * Resolves an available port. If desiredPort is free, returns it immediately.
 * If desiredPort is occupied, sequentially scans candidate ports until a free one is found.
 * 
 * @param desiredPort Preferred port number (e.g. 3000).
 * @param host Host interface to bind (defaults to '0.0.0.0').
 * @param maxAttempts Maximum sequential ports to check before failing.
 * @returns Object containing the chosen port and a boolean flag indicating if a fallback was used.
 */
export async function getAvailablePort(
  desiredPort: number = 3000,
  host: string = '0.0.0.0',
  maxAttempts: number = 50
): Promise<{ port: number; changed: boolean }> {
  const isFree = await isPortAvailable(desiredPort, host);
  if (isFree) {
    return { port: desiredPort, changed: false };
  }

  logger.warn(`[PORT CONFLICT] Desired port ${desiredPort} is already occupied by another service.`);
  logger.info(`Automatically scanning for the next available port starting from ${desiredPort + 1}...`);

  for (let offset = 1; offset <= maxAttempts; offset++) {
    const candidate = desiredPort + offset;
    const candidateFree = await isPortAvailable(candidate, host);
    if (candidateFree) {
      logger.info(`[PORT ACQUIRED] Auto-selected available port: ${candidate}`);
      return { port: candidate, changed: true };
    }
  }

  throw new Error(
    `[FATAL] Unable to find any free port in range ${desiredPort} - ${desiredPort + maxAttempts}. Please specify an open port via PORT environment variable.`
  );
}
