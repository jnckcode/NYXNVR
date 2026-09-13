/**
 * @file LoadGovernor.ts
 * @description Dynamic Adaptive Load Governor for resource-constrained hardware (ARM SBCs, TV Boxes, Celerons).
 * Monitors real-time AI inference latencies and event loop responsiveness to dynamically adapt
 * Stage 1 motion sampling rates, heartbeat intervals, and burst durations.
 * 
 * Tiers:
 * - 🟢 PERFORMANCE (< 120ms): 2.0 FPS sampling, 1000ms heartbeat
 * - 🟡 BALANCED (120 - 250ms): 1.5 FPS sampling, 1500ms heartbeat
 * - 🔴 ECO / POTATO (> 250ms): 1.0 FPS sampling, 2500ms heartbeat
 * 
 * @functions getInstance, recordInferenceDuration, getMetrics, getSamplingIntervalMs, getHeartbeatIntervalMs, getBurstCooldownMs
 * @dependencies events, logger
 */

import EventEmitter from 'events';
import { createLogger } from '../utils/logger';

const logger = createLogger('LoadGovernor');

export type GovernorTier = 'PERFORMANCE' | 'BALANCED' | 'ECO';

export interface GovernorMetrics {
  tier: GovernorTier;
  tierName: string;
  tierBadge: string;
  avgLatencyMs: number;
  samplingFps: number;
  heartbeatIntervalMs: number;
  burstCooldownMs: number;
  memoryRssMb: number;
}

export class LoadGovernor extends EventEmitter {
  private static instance: LoadGovernor;
  private currentTier: GovernorTier = 'PERFORMANCE';
  private latencyHistory: number[] = [];
  private maxHistoryLen = 20;
  private lastTierChangeTime = Date.now();
  private minTierHoldMs = 5000; // Hysteresis hold time to prevent flapping

  private constructor() {
    super();
  }

  public static getInstance(): LoadGovernor {
    if (!LoadGovernor.instance) {
      LoadGovernor.instance = new LoadGovernor();
    }
    return LoadGovernor.instance;
  }

  /**
   * Records completed inference duration and dynamically updates system operational tier.
   */
  public recordInferenceDuration(durationMs: number): void {
    if (isNaN(durationMs) || durationMs <= 0) return;

    this.latencyHistory.push(durationMs);
    if (this.latencyHistory.length > this.maxHistoryLen) {
      this.latencyHistory.shift();
    }

    const avg = this.getAverageLatency();
    const now = Date.now();

    // Only allow tier evaluation every minTierHoldMs to avoid oscillating
    if (now - this.lastTierChangeTime < this.minTierHoldMs) {
      return;
    }

    let targetTier: GovernorTier = 'PERFORMANCE';
    if (avg > 250) {
      targetTier = 'ECO';
    } else if (avg > 120) {
      targetTier = 'BALANCED';
    }

    if (targetTier !== this.currentTier) {
      const oldTier = this.currentTier;
      this.currentTier = targetTier;
      this.lastTierChangeTime = now;

      logger.info(`[LoadGovernor] Operational Tier transitioned: ${oldTier} -> ${targetTier} (Avg Inference Latency: ${avg.toFixed(1)}ms)`);
      this.emit('tierChanged', this.getMetrics());
    }
  }

  /**
   * Returns current rolling average inference latency in milliseconds.
   */
  public getAverageLatency(): number {
    if (this.latencyHistory.length === 0) return 60;
    const sum = this.latencyHistory.reduce((a, b) => a + b, 0);
    return sum / this.latencyHistory.length;
  }

  /**
   * Returns current active operational tier.
   */
  public getTier(): GovernorTier {
    return this.currentTier;
  }

  /**
   * Returns heartbeat scan interval in milliseconds adapted to current load tier.
   */
  public getHeartbeatIntervalMs(): number {
    switch (this.currentTier) {
      case 'ECO':
        return 2500;
      case 'BALANCED':
        return 1500;
      case 'PERFORMANCE':
      default:
        return 1000;
    }
  }

  /**
   * Returns burst cooldown window in milliseconds.
   */
  public getBurstCooldownMs(): number {
    switch (this.currentTier) {
      case 'ECO':
        return 2000;
      case 'BALANCED':
        return 3000;
      case 'PERFORMANCE':
      default:
        return 4000;
    }
  }

  /**
   * Returns current governor metrics and telemetry snapshot.
   */
  public getMetrics(): GovernorMetrics {
    const avg = Math.round(this.getAverageLatency());
    const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    let tierBadge = '🟢 Performance';
    let fps = 2.0;

    if (this.currentTier === 'BALANCED') {
      tierBadge = '🟡 Balanced';
      fps = 1.5;
    } else if (this.currentTier === 'ECO') {
      tierBadge = '🔴 Eco / Potato';
      fps = 1.0;
    }

    return {
      tier: this.currentTier,
      tierName: this.currentTier,
      tierBadge,
      avgLatencyMs: avg,
      samplingFps: fps,
      heartbeatIntervalMs: this.getHeartbeatIntervalMs(),
      burstCooldownMs: this.getBurstCooldownMs(),
      memoryRssMb: memMb
    };
  }
}
