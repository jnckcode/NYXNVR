/**
 * @file schema.ts
 * @description Database schema definitions, index creations, and seed data initialization.
 * @functions initSchema, seedDefaultSettings
 * @dependencies better-sqlite3, database, constants
 */

import { getDatabase } from './database';
import { DEFAULT_SETTINGS } from '../config/constants';

/**
 * Initializes SQLite schema tables, indexes, and default settings seeds.
 */
export function initSchema(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rtsp_url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      ai_enabled INTEGER DEFAULT 0,
      roi_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      label TEXT NOT NULL,
      confidence REAL NOT NULL,
      snapshot_path TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_filepath ON recordings (file_path);
    CREATE INDEX IF NOT EXISTS idx_recordings_camera_time ON recordings (camera_id, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings (start_time ASC);
    CREATE INDEX IF NOT EXISTS idx_events_camera_time ON events (camera_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_label ON events (label);
  `);

  // Seed default settings if not already present
  seedDefaultSettings();
}

/**
 * Populates initial default settings into the settings table.
 */
export function seedDefaultSettings(): void {
  const db = getDatabase();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);

  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertStmt.run(key, value);
    }
  });

  tx();
}
