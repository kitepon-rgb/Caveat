-- v2: track when each entry was last surfaced by retrieval (hook / search tool).
-- Null for entries that have never been hit since the column was added.
ALTER TABLE entries ADD COLUMN last_hit_at TEXT;
