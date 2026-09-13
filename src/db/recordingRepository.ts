/**
 * @file recordingRepository.ts
 * @description SQLite repository for indexing and querying MP4 video segments and managing retention deletions.
 * @functions create, getById, getFiltered, getOldestRecordings, deleteById, deleteBatch
 * @dependencies better-sqlite3, database, types/recording
 */

import crypto from 'crypto';
import { getDatabase } from './database';
import { RecordingSegment, RecordingFilter } from '../types/recording';

export class RecordingRepository {
  /**
   * Records a new completed MP4 recording segment.
   */
  public static create(data: {
    cameraId: string;
    filePath: string;
    fileSize: number;
    startTime: string;
    endTime: string;
  }): RecordingSegment {
    const db = getDatabase();
    
    // Check if already indexed first to avoid duplicate work
    const existing = this.getByPath(data.filePath);
    if (existing) {
      return existing;
    }

    const id = `rec_${crypto.randomBytes(6).toString('hex')}`;

    db.prepare(`
      INSERT OR IGNORE INTO recordings (id, camera_id, file_path, file_size, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.cameraId, data.filePath, data.fileSize, data.startTime, data.endTime);

    return this.getById(id) || this.getByPath(data.filePath)!;
  }

  /**
   * Retrieves a recording segment by its file path.
   */
  public static getByPath(filePath: string): RecordingSegment | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM recordings WHERE file_path = ?').get(filePath) as RecordingSegment | undefined;
    return row || null;
  }

  /**
   * Retrieves a recording segment by ID.
   */
  public static getById(id: string): RecordingSegment | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingSegment | undefined;
    return row || null;
  }

  /**
   * Retrieves filtered recordings by camera ID, start/end dates with pagination.
   */
  public static getFiltered(filter: RecordingFilter): { total: number; recordings: RecordingSegment[] } {
    const db = getDatabase();
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.cameraId) {
      conditions.push('camera_id = ?');
      params.push(filter.cameraId);
    }

    if (filter.startDate) {
      conditions.push('start_time >= ?');
      params.push(filter.startDate);
    }

    if (filter.endDate) {
      conditions.push('end_time <= ?');
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM recordings ${whereClause}`).get(...params) as { count: number };
    const total = countRow.count;

    const limit = filter.limit || 50;
    const offset = filter.offset || 0;

    const recordings = db.prepare(`
      SELECT * FROM recordings 
      ${whereClause} 
      ORDER BY start_time DESC 
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RecordingSegment[];

    return { total, recordings };
  }

  /**
   * Retrieves the earliest recording in the database.
   */
  public static getOldestRecording(): RecordingSegment | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM recordings ORDER BY start_time ASC LIMIT 1').get() as RecordingSegment | undefined;
    return row || null;
  }

  /**
   * Retrieves the oldest recordings for retention cleanup.
   */
  public static getOldestRecordings(limit: number = 20): RecordingSegment[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM recordings ORDER BY start_time ASC LIMIT ?').all(limit) as RecordingSegment[];
  }

  /**
   * Retrieves recordings older than a specified ISO date string.
   */
  public static getRecordingsOlderThan(dateIso: string): RecordingSegment[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM recordings WHERE start_time < ? ORDER BY start_time ASC').all(dateIso) as RecordingSegment[];
  }

  /**
   * Deletes a recording entry by ID.
   */
  public static deleteById(id: string): boolean {
    const db = getDatabase();
    const info = db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Deletes multiple recordings by IDs.
   */
  public static deleteBatch(ids: string[]): number {
    if (ids.length === 0) return 0;
    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM recordings WHERE id IN (${placeholders})`).run(...ids);
    return info.changes;
  }
}
