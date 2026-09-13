/**
 * @file logger.ts
 * @description Lightweight structured logger with timestamps, tags, and severity levels.
 * @functions logInfo, logWarn, logError, logDebug, createLogger
 * @dependencies none
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  private format(level: LogLevel, message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.tag}]`;
    if (level === 'ERROR') {
      console.error(prefix, message, ...args);
    } else if (level === 'WARN') {
      console.warn(prefix, message, ...args);
    } else {
      console.log(prefix, message, ...args);
    }
  }

  public info(message: string, ...args: any[]): void {
    this.format('INFO', message, ...args);
  }

  public warn(message: string, ...args: any[]): void {
    this.format('WARN', message, ...args);
  }

  public error(message: string, ...args: any[]): void {
    this.format('ERROR', message, ...args);
  }

  public debug(message: string, ...args: any[]): void {
    this.format('DEBUG', message, ...args);
  }
}

export function createLogger(tag: string): Logger {
  return new Logger(tag);
}
