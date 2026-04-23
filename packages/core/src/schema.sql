PRAGMA user_version = 2;

CREATE TABLE entries (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  tags TEXT,
  confidence TEXT,
  visibility TEXT,
  file_mtime TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  last_hit_at TEXT,
  UNIQUE (source, id)
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  id UNINDEXED, title, body, tags,
  content='entries', content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, body, tags)
  VALUES('delete', old.rowid, old.id, old.title, old.body, old.tags);
END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, body, tags)
  VALUES('delete', old.rowid, old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;
