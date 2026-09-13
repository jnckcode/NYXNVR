/**
 * @file pathSanitizer.ts
 * @description Path sanitization and directory validation to prevent Path Traversal and illegal filesystem access.
 * @functions sanitizePath, isSafeSubpath, ensureDirExists
 * @dependencies path, fs
 */

import path from 'path';
import fs from 'fs';

/**
 * Normalizes and resolves a target filesystem path safely.
 */
export function sanitizePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Invalid path provided');
  }
  // Trim and normalize slashes
  const trimmed = inputPath.trim();
  return path.normalize(path.resolve(trimmed));
}

/**
 * Validates that a target file/folder is strictly located inside an allowed root directory.
 */
export function isSafeSubpath(parentDir: string, targetPath: string): boolean {
  const safeParent = path.resolve(parentDir);
  const safeTarget = path.resolve(targetPath);
  return safeTarget.startsWith(safeParent + path.sep) || safeTarget === safeParent;
}

/**
 * Ensures directory exists, creating recursive directories if needed.
 */
export function ensureDirExists(dirPath: string): string {
  const resolved = sanitizePath(dirPath);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}
