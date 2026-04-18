import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, 'schema.sql');
const MIGRATIONS_DIR = join(here, 'migrations');

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export const stderrLogger: Logger = {
  info: (m) => process.stderr.write(`[caveat] ${m}\n`),
  warn: (m) => process.stderr.write(`[caveat:warn] ${m}\n`),
  error: (m) => process.stderr.write(`[caveat:error] ${m}\n`),
};

export interface OpenDbOptions {
  path: string;
  logger?: Logger;
}

export function openDb(opts: OpenDbOptions): DatabaseSync {
  const db = new DatabaseSync(opts.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };

  if (user_version === 0) {
    db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
  } else {
    applyMigrations(db, user_version);
  }

  return db;
}

function applyMigrations(db: DatabaseSync, currentVersion: number): void {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const n = Number(file.split('_')[0]);
    if (n <= currentVersion) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${n}`);
  }
}
