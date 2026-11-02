import { env } from '../config/env';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const threshold = LEVELS[env.logLevel as Level] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}