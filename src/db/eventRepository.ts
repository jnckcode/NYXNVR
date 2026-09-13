/**
 * @file eventRepository.ts
 * @description SQLite repository for logging and querying AI detection events, snapshots, and labels.
 * @functions create, getById, getFiltered, getRecent, deleteById
 * @dependencies better-sqlite3, database, types/event
 */

import crypto from 'crypto';
import { getDatabase } from './database';
import { AIEvent, EventFilter } from '../types/event';

export class EventRepository {
  /**
   * Records a new AI detection event.
   */
  public static create(data: {
    cameraId: string;
    label: string;
    confidence: number;
    snapshotPath: string;
    timestamp?: string;
  }): AIEvent {
    const db = getDatabase();
    const id = `evt_${crypto.randomBytes(6).toString('hex')}`;
    const timestamp = data.timestamp || new Date().toISOString();

    db.prepare(`
      INSERT INTO events (id, camera_id, label, confidence, snapshot_path, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.cameraId, data.label, data.confidence, data.snapshotPath, timestamp);

    return this.getById(id)!;
  }

  /**
   * Retrieves an AI event by ID.
   */
  public static getById(id: string): AIEvent | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as AIEvent | undefined;
    return row || null;
  }

  /**
   * Retrieves filtered AI events by camera ID, label, date range, and confidence.
   */
  public static getFiltered(filter: EventFilter): { total: number; events: AIEvent[] } {
    const db = getDatabase();
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.cameraId) {
      conditions.push('camera_id = ?');
      params.push(filter.cameraId);
    }

    if (filter.label) {
      conditions.push('label = ?');
      params.push(filter.label);
    }

    if (filter.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(filter.minConfidence);
    }

    if (filter.startDate) {
      conditions.push('timestamp >= ?');
      params.push(filter.startDate);
    }

    if (filter.endDate) {
      conditions.push('timestamp <= ?');
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM events ${whereClause}`).get(...params) as { count: number };
    const total = countRow.count;

    const limit = filter.limit || 50;
    const offset = filter.offset || 0;

    const events = db.prepare(`
      SELECT * FROM events 
      ${whereClause} 
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as AIEvent[];

    return { total, events };
  }

  /**
   * Retrieves recent events for dashboard ticker / real-time widget.
   */
  public static getRecent(limit: number = 10): AIEvent[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?').all(limit) as AIEvent[];
  }

  /**
   * Retrieves events older than a specified ISO date string.
   */
  public static getEventsOlderThan(dateIso: string): AIEvent[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM events WHERE timestamp < ? ORDER BY timestamp ASC').all(dateIso) as AIEvent[];
  }

  /**
   * Deletes an event by ID.
   */
  public static deleteById(id: string): boolean {
    const db = getDatabase();
    const info = db.prepare('DELETE FROM events WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Deletes multiple events by IDs.
   */
  public static deleteBatch(ids: string[]): number {
    if (ids.length === 0) return 0;
    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...ids);
    return info.changes;
  }
}
