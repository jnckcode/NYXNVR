/**
 * @file test.ts
 * @description Comprehensive automated integration test verifying SQLite WAL mode, SettingsService, Repositories, MotionFilter, and Fastify Server routes.
 * @functions runAllTests
 * @dependencies db/schema, core/SettingsService, ai/MotionFilter, db/cameraRepository, db/eventRepository, db/recordingRepository, api/server
 */

import { initSchema } from './db/schema';
import { getDatabase, closeDatabase } from './db/database';
import { SettingsService } from './core/SettingsService';
import { CameraRepository } from './db/cameraRepository';
import { RecordingRepository } from './db/recordingRepository';
import { EventRepository } from './db/eventRepository';
import { MotionFilter } from './ai/MotionFilter';
import { createServer } from './api/server';

async function runAllTests(): Promise<void> {
  console.log('====================================================');
  console.log('   ANTIGRAVITY NVR - AUTOMATED SYSTEM INTEGRATION TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  try {
    // 1. Database & Schema Initialization Test
    console.log('--- Test Group 1: Database & Schema ---');
    initSchema();
    const db = getDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    assert(tables.includes('cameras'), 'Table `cameras` exists');
    assert(tables.includes('recordings'), 'Table `recordings` exists');
    assert(tables.includes('events'), 'Table `events` exists');
    assert(tables.includes('settings'), 'Table `settings` exists');

    const pragmaWal: any = db.pragma('journal_mode');
    assert(pragmaWal === 'wal' || (Array.isArray(pragmaWal) && pragmaWal[0]?.journal_mode === 'wal'), 'SQLite journal mode is WAL');

    // 2. SettingsService & Dynamic Paths Test
    console.log('\n--- Test Group 2: SettingsService Dynamic Config ---');
    const settingsService = SettingsService.getInstance();
    const initialSettings = settingsService.getSettings();
    assert(typeof initialSettings.recording_path === 'string', 'Default recording path initialized');
    assert(Number(initialSettings.retention_days) >= 1, 'Default retention days initialized');

    settingsService.updateSettings({ retention_days: 14, disk_threshold_percent: 90 });
    const updatedSettings = settingsService.getSettings();
    assert(updatedSettings.retention_days === 14, 'SettingsService dynamically updated retention_days');
    assert(updatedSettings.disk_threshold_percent === 90, 'SettingsService dynamically updated disk_threshold_percent');

    const diskInfo = settingsService.getDiskInfo();
    assert(diskInfo.totalBytes > 0, `Disk capacity check: ${Math.round(diskInfo.totalBytes / (1024*1024*1024))} GB detected`);

    // 3. Camera Repository CRUD & ROI Test
    console.log('\n--- Test Group 3: Camera Repository & ROI Config ---');
    const newCam = CameraRepository.create({
      name: 'Test Gate CCTV',
      rtsp_url: 'rtsp://192.168.1.100:554/live/ch0',
      enabled: true,
      ai_enabled: false
    });
    assert(newCam.name === 'Test Gate CCTV', 'Camera created successfully in SQLite');

    const toggledAi = CameraRepository.toggleAI(newCam.id, true);
    assert(toggledAi?.ai_enabled === 1, 'Camera AI toggle updated to ON');

    const roiConfig = {
      enabled: true,
      polygons: [[{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }]]
    };
    const withRoi = CameraRepository.updateROI(newCam.id, roiConfig);
    assert(withRoi?.roi_config !== null, 'Camera ROI polygon mask saved in SQLite');

    // 4. MotionFilter Stage 1 Pixel Differencing Test
    console.log('\n--- Test Group 4: MotionFilter Stage 1 Pixel Differencing ---');
    const filter = new MotionFilter(160, 120, 2.0, 20);
    const frameA = Buffer.alloc(160 * 120, 50); // Uniform gray
    const resA = filter.processFrame(frameA);
    assert(resA.hasMotion === false, 'First frame establishes baseline (no motion)');

    const frameB = Buffer.alloc(160 * 120, 50);
    // Introduce 15% changed pixels
    for (let i = 0; i < 160 * 120 * 0.15; i++) {
      frameB[i] = 180;
    }
    const resB = filter.processFrame(frameB);
    assert(resB.hasMotion === true, `Motion detected: Score = ${resB.score}% (expected > 2%)`);

    // 5. Recording & Event Repositories Test
    console.log('\n--- Test Group 5: Recording & Event Repositories ---');
    const testRec = RecordingRepository.create({
      cameraId: newCam.id,
      filePath: 'storage/recordings/test.mp4',
      fileSize: 5242880,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString()
    });
    assert(testRec.id.startsWith('rec_'), 'Recording segment recorded in SQLite');

    const testEvent = EventRepository.create({
      cameraId: newCam.id,
      label: 'person',
      confidence: 0.88,
      snapshotPath: 'snapshots/test.jpg'
    });
    assert(testEvent.label === 'person' && testEvent.confidence === 0.88, 'AI Event recorded in SQLite');

    // Clean up test camera
    CameraRepository.delete(newCam.id);

    // 6. Fastify REST API Server Test
    console.log('\n--- Test Group 6: Fastify REST API Routes ---');
    const server = await createServer();
    const camRes = await server.inject({ method: 'GET', url: '/api/v1/cameras' });
    assert(camRes.statusCode === 200, 'GET /api/v1/cameras returned 200 OK');

    const setRes = await server.inject({ method: 'GET', url: '/api/v1/settings' });
    assert(setRes.statusCode === 200, 'GET /api/v1/settings returned 200 OK');

    const metricsRes = await server.inject({ method: 'GET', url: '/api/v1/system/metrics' });
    assert(metricsRes.statusCode === 200, 'GET /api/v1/system/metrics returned 200 OK');

    await server.close();
    closeDatabase();

    console.log('\n====================================================');
    console.log(`   TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err: any) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runAllTests();
