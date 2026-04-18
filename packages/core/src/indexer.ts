import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseMarkdown } from './frontmatter.js';
import type { Source } from './types.js';

export interface ScanSourceOptions {
  db: DatabaseSync;
  source: Source;
  entriesRoot: string;
  now?: () => string;
}

export interface ScanResult {
  added: number;
  updated: number;
  deleted: number;
}

export function scanSource(opts: ScanSourceOptions): ScanResult {
  const { db, source, entriesRoot } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  db.exec('DROP TABLE IF EXISTS temp.touched');
  db.exec('CREATE TEMP TABLE touched(rowid INTEGER PRIMARY KEY)');
  const insertTouched = db.prepare('INSERT INTO touched (rowid) VALUES (?)');

  let added = 0;
  let updated = 0;

  if (existsSync(entriesRoot)) {
    for (const filePath of walkMarkdown(entriesRoot)) {
      const stat = statSync(filePath);
      const mtime = stat.mtime.toISOString();
      const rel = relative(entriesRoot, filePath).replace(/\\/g, '/');
      const src = readFileSync(filePath, 'utf-8');
      const parsed = parseMarkdown(src);
      const fm = parsed.frontmatter;

      const existing = db
        .prepare('SELECT rowid, file_mtime, path FROM entries WHERE source = ? AND id = ?')
        .get(source, fm.id) as { rowid: number; file_mtime: string; path: string } | undefined;

      if (existing && existing.file_mtime === mtime && existing.path === rel) {
        insertTouched.run(existing.rowid);
        continue;
      }

      const rowid = upsertEntry(db, {
        id: fm.id,
        source,
        path: rel,
        title: fm.title,
        body: parsed.body,
        frontmatter_json: JSON.stringify(fm),
        tags: JSON.stringify(fm.tags ?? []),
        confidence: fm.confidence,
        visibility: fm.visibility,
        file_mtime: mtime,
        indexed_at: now(),
      });
      insertTouched.run(rowid);

      if (existing) updated++;
      else added++;
    }
  }

  const del = db
    .prepare('DELETE FROM entries WHERE source = ? AND rowid NOT IN (SELECT rowid FROM touched)')
    .run(source);
  const deleted = Number(del.changes);

  db.exec('DROP TABLE temp.touched');

  return { added, updated, deleted };
}

interface UpsertRow {
  id: string;
  source: Source;
  path: string;
  title: string;
  body: string;
  frontmatter_json: string;
  tags: string;
  confidence: string;
  visibility: string;
  file_mtime: string;
  indexed_at: string;
}

export function upsertEntry(db: DatabaseSync, row: UpsertRow): number {
  const existing = db
    .prepare('SELECT rowid FROM entries WHERE source = ? AND id = ?')
    .get(row.source, row.id) as { rowid: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE entries
       SET path = ?, title = ?, body = ?, frontmatter_json = ?, tags = ?,
           confidence = ?, visibility = ?, file_mtime = ?, indexed_at = ?
       WHERE source = ? AND id = ?`,
    ).run(
      row.path, row.title, row.body, row.frontmatter_json, row.tags,
      row.confidence, row.visibility, row.file_mtime, row.indexed_at,
      row.source, row.id,
    );
    return existing.rowid;
  }

  const info = db.prepare(
    `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.source, row.path, row.title, row.body, row.frontmatter_json,
    row.tags, row.confidence, row.visibility, row.file_mtime, row.indexed_at,
  );
  return Number(info.lastInsertRowid);
}

export function rebuildAll(db: DatabaseSync): void {
  db.exec('DELETE FROM entries');
}

function* walkMarkdown(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}
