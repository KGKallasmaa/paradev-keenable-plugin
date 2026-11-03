-- BM25 ranking for chat search through Neon's lakebase_text. Only Neon
-- projects with Lakebase Search have the extension; plain Postgres (local
-- docker, CI) and other Neon projects skip this, and chat search falls back
-- to the GIN index. Custom migration: Drizzle cannot express the condition.

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'lakebase_text') THEN
		CREATE EXTENSION IF NOT EXISTS lakebase_text;
		CREATE INDEX IF NOT EXISTS chat_items_search_bm25 ON chat_items USING lakebase_bm25 (search);
	END IF;
END
$$;
