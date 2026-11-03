-- Search text for chat_items.search. The default tokenizer keeps paths and
-- dotted or camelCase names as one word, so code names never match a search.
-- This adds a copy split on / . _ : and on camelCase. Custom migration:
-- chat_items.search is generated from it, so it must exist first.

CREATE OR REPLACE FUNCTION chat_search_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT t || ' ' || regexp_replace(
		regexp_replace(t, '([a-z0-9])([A-Z])', '\1 \2', 'g'),
		'[/._:()\[\]{}<>`#=-]+', ' ', 'g'
	)
$$;
