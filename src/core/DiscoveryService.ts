/**
 * @file DiscoveryService.ts
 * @description Auto-discovery engine for local IP cameras utilizing ONVIF WS-Discovery and subnet RTSP port scanning.
 * @functions discoverCameras, probeOnvif, scanSubnetRtsp
 * @dependencies dgram, net, os, types/discovery, utils/logger
 */

import dgram from 'dgram';
import net from 'net';
import os from 'os';
import { DiscoveredCamera, DiscoveryScanResult } from '../types/discovery';
import { createLogger } from '../utils/logger';

const logger = createLogger('DiscoveryService');

export class DiscoveryService {
  /**
   * Performs full network camera auto-discovery via ONVIF WS-Discovery and subnet port scanning.
   */
  public static async discoverCameras(timeoutMs: number = 4000): Promise<DiscoveryScanResult> {
    const startTime = Date.now();
    logger.info('Starting network camera discovery scan...');

    const foundMap = new Map<string, DiscoveredCamera>();

    try {
      // Run ONVIF and RTSP subnet scan in parallel
      const [onvifDevices, rtspDevices] = await Promise.all([
        this.probeOnvif(timeoutMs),
        this.scanSubnetRtsp(timeoutMs)
      ]);

      // Merge results
      for (const dev of onvifDevices) {
        foundMap.set(`${dev.ip}:${dev.port}`, dev);
      }

      for (const dev of rtspDevices) {
        const key = `${dev.ip}:${dev.port}`;
        if (!foundMap.has(key)) {
          foundMap.set(key, dev);
        }
      }
    } catch (err) {
      logger.error('Error during camera discovery:', err);
    }

    const cameras = Array.from(foundMap.values());
    const duration = Date.now() - startTime;
    logger.info(`Discovery complete in ${duration}ms. Found ${cameras.length} devices.`);

    return {
      scanDurationMs: duration,
      devicesFound: cameras.length,
      cameras
    };
  }

  /**
   * Sends ONVIF WS-Discovery UDP multicast probe to 239.255.255.250:3702.
   */
  private static probeOnvif(timeoutMs: number): Promise<DiscoveredCamera[]> {
    return new Promise((resolve) => {
      const devices: DiscoveredCamera[] = [];
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const multicastAddress = '239.255.255.250';
      const multicastPort = 3702;

      const probeUuid = 'uuid:' + Math.random().toString(36).substring(2, 15);
      const probeXml = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
        <e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
                    xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
                    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
                    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
          <e:Header>
            <w:MessageID>${probeUuid}</w:MessageID>
            <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
            <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
          </e:Header>
          <e:Body>
            <d:Probe>
              <d:Types>dn:NetworkVideoTransmitter</d:Types>
            </d:Probe>
          </e:Body>
        </e:Envelope>`
      );

      socket.on('message', (msg, rinfo) => {
        const text = msg.toString();
        // Extract XAddrs or endpoint reference
        const xaddrMatch = text.match(/<d:XAddrs>(.*?)<\/d:XAddrs>/i) || text.match(/http:\/\/([^\/:]+)(?::(\d+))?\/([^\s<]+)/i);
        const ip = rinfo.address;
        const port = 554; // Default RTSP port

        let name = `ONVIF Camera (${ip})`;
        const nameMatch = text.match(/onvif:\/\/www\.onvif\.org\/name\/([^\s<]+)/i);
        if (nameMatch) {
          name = decodeURIComponent(nameMatch[1]);
        }

        devices.push({
          ip,
          port,
          protocol: 'ONVIF',
          name,
          rtspUrl: `rtsp://${ip}:${port}/live/ch00_0`,
          xaddr: xaddrMatch ? xaddrMatch[0] : undefined
        });
      });

      socket.on('error', (err) => {
        logger.debug('ONVIF socket error:', err.message);
      });

      socket.bind(() => {
        try {
          socket.setBroadcast(true);
          socket.setMulticastTTL(2);
          socket.send(probeXml, 0, probeXml.length, multicastPort, multicastAddress);
        } catch (e) {
          // ignore
        }
      });

      setTimeout(() => {
        try {
          socket.close();
        } catch (e) {
          // ignore
        }
        resolve(devices);
      }, timeoutMs);
    });
  }

  /**
   * Scans the local subnet for open RTSP ports (554, 8554).
   */
  private static async scanSubnetRtsp(timeoutMs: number): Promise<DiscoveredCamera[]> {
    const localIps = this.getLocalSubnetIps();
    if (localIps.length === 0) return [];

    const discovered: DiscoveredCamera[] = [];
    const portsToScan = [554, 8554];

    const checkPort = (ip: string, port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(400); // Fast connection probe

        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });

        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(port, ip);
      });
    };

    // Scan in polite chunks of 16 parallel sockets with low CPU impact
    const chunkSize = 16;
    for (let i = 0; i < localIps.length; i += chunkSize) {
      const chunk = localIps.slice(i, i + chunkSize);
      const promises = chunk.flatMap((ip) =>
        portsToScan.map(async (port) => {
          const isOpen = await checkPort(ip, port);
          if (isOpen) {
            discovered.push({
              ip,
              port,
              protocol: 'RTSP',
              name: `IP Camera (${ip}:${port})`,
              rtspUrl: `rtsp://${ip}:${port}/live/ch00_0`
            });
          }
        })
      );

      await Promise.all(promises);
      // Small 10ms yield to prevent CPU thread locking
      await new Promise(r => setTimeout(r, 10));
    }

    return discovered;
  }

  /**
   * Retrieves IP addresses in the primary /24 local subnet (filters out WSL, VirtualBox, and APIPA).
   */
  private static getLocalSubnetIps(): string[] {
    const ips: string[] = [];
    const interfaces = os.networkInterfaces();
    let primaryPrefix: string | null = null;

    // Prefer 192.168.x.x or 10.x.x.x interfaces
    for (const name of Object.keys(interfaces)) {
      const lowerName = name.toLowerCase();
      // Skip virtual adapters on Windows/Linux
      if (lowerName.includes('vEthernet') || lowerName.includes('virtual') || lowerName.includes('wsl') || lowerName.includes('docker') || lowerName.includes('tailscale') || lowerName.includes('zerotier')) {
        continue;
      }

      for (const netInfo of interfaces[name] || []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal && !netInfo.address.startsWith('169.254.')) {
          const parts = netInfo.address.split('.');
          if (parts.length === 4) {
            primaryPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
            const myAddress = netInfo.address;

            // Only scan the primary subnet (up to 254 addresses)
            for (let host = 1; host <= 254; host++) {
              const targetIp = `${primaryPrefix}.${host}`;
              if (targetIp !== myAddress) {
                ips.push(targetIp);
              }
            }
            return ips; // Restrict scan to primary network interface only
          }
        }
      }
    }

    return ips;
  }
}
