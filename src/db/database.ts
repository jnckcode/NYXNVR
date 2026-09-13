/**
 * @file database.ts
 * @description SQLite database connection manager using better-sqlite3 with WAL mode and resilient configuration.
 * @functions getDatabase, closeDatabase, initializeDatabase
 * @dependencies better-sqlite3, fs, path, SYSTEM_CONSTANTS
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SYSTEM_CONSTANTS } from '../config/constants';

let dbInstance: DatabaseType | null = null;

/**
 * Returns the singleton SQLite database instance.
 * Automatically initializes WAL mode and foreign keys.
 */
export function getDatabase(): DatabaseType {
  if (!dbInstance) {
    const dbDir = path.dirname(SYSTEM_CONSTANTS.DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    dbInstance = new Database(SYSTEM_CONSTANTS.DB_PATH);

    // Performance and resilience pragmas
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('temp_store = MEMORY');
    dbInstance.pragma('cache_size = -8000'); // 8MB memory cache
  }

  return dbInstance;
}

/**
 * Safely closes the database connection.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (err) {
      console.error('[DB] Error closing database:', err);
    } finally {
      dbInstance = null;
    }
  }
}
