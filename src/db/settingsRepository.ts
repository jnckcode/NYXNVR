/**
 * @file settingsRepository.ts
 * @description Repository for querying, updating, and caching dynamic system settings in SQLite.
 * @functions getSetting, getAllSettings, setSetting, setSettingsBatch
 * @dependencies better-sqlite3, database, types
 */

import { getDatabase } from './database';
import { SystemSettingsMap } from '../types/settings';
import { DEFAULT_SETTINGS, SYSTEM_CONSTANTS } from '../config/constants';

export class SettingsRepository {
  /**
   * Retrieves a single setting value by its key.
   */
  public static get(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Retrieves all settings as a key-value dictionary with typed defaults.
   */
  public static getAll(): SystemSettingsMap {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    
    const settings: Record<string, string | number> = {
      recording_path: DEFAULT_SETTINGS.recording_path,
      ai_model_path: DEFAULT_SETTINGS.ai_model_path,
      retention_days: SYSTEM_CONSTANTS.DEFAULT_RETENTION_DAYS,
      retention_hours: SYSTEM_CONSTANTS.DEFAULT_RETENTION_HOURS,
      auto_delete_enabled: SYSTEM_CONSTANTS.DEFAULT_AUTO_DELETE_ENABLED,
      auto_delete_snapshots: SYSTEM_CONSTANTS.DEFAULT_AUTO_DELETE_SNAPSHOTS,
      disk_threshold_percent: SYSTEM_CONSTANTS.DEFAULT_DISK_THRESHOLD_PERCENT,
      ai_confidence_threshold: 0.20,
      ai_iou_threshold: 0.45,
      ai_target_classes: 'person,car,motorcycle,bicycle,bus,truck,dog,cat',
      ai_continuous_mode: 0,
      ai_motion_sensitivity: 0.4
    };

    for (const row of rows) {
      if (
        row.key === 'retention_days' ||
        row.key === 'retention_hours' ||
        row.key === 'auto_delete_enabled' ||
        row.key === 'auto_delete_snapshots' ||
        row.key === 'disk_threshold_percent' ||
        row.key === 'ai_continuous_mode'
      ) {
        const num = parseInt(row.value, 10);
        settings[row.key] = isNaN(num) ? settings[row.key] : num;
      } else if (row.key === 'ai_confidence_threshold' || row.key === 'ai_iou_threshold' || row.key === 'ai_motion_sensitivity') {
        const num = parseFloat(row.value);
        settings[row.key] = isNaN(num) ? settings[row.key] : num;
      } else {
        settings[row.key] = row.value;
      }
    }

    return settings as unknown as SystemSettingsMap;
  }

  /**
   * Sets or updates a single setting key.
   */
  public static set(key: string, value: string | number): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  /**
   * Updates multiple settings inside a single SQLite transaction.
   */
  public static setBatch(settings: Partial<SystemSettingsMap>): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) {
          stmt.run(key, String(value));
        }
      }
    });

    tx();
  }
}
