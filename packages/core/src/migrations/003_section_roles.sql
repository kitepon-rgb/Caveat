-- v3: classify each entry's text into role buckets so the surface gate can
-- demand at least one match in the symptom section ("situational"), not just
-- topical (title / tags / environment) overlap.
-- Existing rows have NULL until db.ts backfills from stored body + frontmatter
-- on first openDb after migration.
ALTER TABLE entries ADD COLUMN topical_text TEXT;
ALTER TABLE entries ADD COLUMN symptom_text TEXT;
