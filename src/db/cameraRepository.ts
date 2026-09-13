/**
 * @file cameraRepository.ts
 * @description SQLite repository for IP camera CRUD operations, AI toggles, and ROI configuration management.
 * @functions getAll, getById, create, update, delete, toggleEnabled, toggleAI, updateROI
 * @dependencies better-sqlite3, database, types/camera
 */

import crypto from 'crypto';
import { getDatabase } from './database';
import { Camera, CameraCreateInput, CameraUpdateInput, ROIConfig } from '../types/camera';

export class CameraRepository {
  /**
   * Retrieves all registered cameras.
   */
  public static getAll(): Camera[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM cameras ORDER BY created_at ASC').all() as Camera[];
  }

  /**
   * Retrieves all currently enabled cameras.
   */
  public static getEnabled(): Camera[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM cameras WHERE enabled = 1 ORDER BY created_at ASC').all() as Camera[];
  }

  /**
   * Retrieves a single camera by ID.
   */
  public static getById(id: string): Camera | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id) as Camera | undefined;
    return row || null;
  }

  /**
   * Creates a new camera record.
   */
  public static create(input: CameraCreateInput): Camera {
    const db = getDatabase();
    const id = `cam_${crypto.randomBytes(6).toString('hex')}`;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : 1;
    const ai_enabled = input.ai_enabled !== undefined ? (input.ai_enabled ? 1 : 0) : 0;
    
    let roi_config: string | null = null;
    if (input.roi_config) {
      roi_config = typeof input.roi_config === 'string' ? input.roi_config : JSON.stringify(input.roi_config);
    }

    db.prepare(`
      INSERT INTO cameras (id, name, rtsp_url, enabled, ai_enabled, roi_config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.name.trim(), input.rtsp_url.trim(), enabled, ai_enabled, roi_config);

    return this.getById(id)!;
  }

  /**
   * Updates an existing camera record.
   */
  public static update(id: string, input: CameraUpdateInput): Camera | null {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) return null;

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const rtsp_url = input.rtsp_url !== undefined ? input.rtsp_url.trim() : existing.rtsp_url;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const ai_enabled = input.ai_enabled !== undefined ? (input.ai_enabled ? 1 : 0) : existing.ai_enabled;

    let roi_config = existing.roi_config;
    if (input.roi_config !== undefined) {
      roi_config = input.roi_config === null ? null : (typeof input.roi_config === 'string' ? input.roi_config : JSON.stringify(input.roi_config));
    }

    db.prepare(`
      UPDATE cameras 
      SET name = ?, rtsp_url = ?, enabled = ?, ai_enabled = ?, roi_config = ?
      WHERE id = ?
    `).run(name, rtsp_url, enabled, ai_enabled, roi_config, id);

    return this.getById(id);
  }

  /**
   * Toggles the enabled state of a camera.
   */
  public static toggleEnabled(id: string, enabled: boolean): Camera | null {
    const db = getDatabase();
    db.prepare('UPDATE cameras SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.getById(id);
  }

  /**
   * Toggles the AI detection state of a camera.
   */
  public static toggleAI(id: string, aiEnabled: boolean): Camera | null {
    const db = getDatabase();
    db.prepare('UPDATE cameras SET ai_enabled = ? WHERE id = ?').run(aiEnabled ? 1 : 0, id);
    return this.getById(id);
  }

  /**
   * Updates the ROI polygon mask for a camera.
   */
  public static updateROI(id: string, roiConfig: ROIConfig | null): Camera | null {
    const db = getDatabase();
    const roiStr = roiConfig ? JSON.stringify(roiConfig) : null;
    db.prepare('UPDATE cameras SET roi_config = ? WHERE id = ?').run(roiStr, id);
    return this.getById(id);
  }

  /**
   * Deletes a camera by ID (recordings and events cascade delete).
   */
  public static delete(id: string): boolean {
    const db = getDatabase();
    const info = db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
