// Tables for the two ways a county can keep CountyWyde in sync with its own
// website without re-uploading by hand:
//   - county_api_keys:   push. The county's developers call /api/v1 with a key.
//   - document_sources:  pull. CountyWyde checks a registered page/feed on a
//                        schedule, no code needed on the county's side.
//   - source_documents:  every file already ingested from a source, so a
//                        re-check only picks up new or changed files.
//
// Keys and sources are scoped to a county+state (every account in that county
// sees and manages them), with account_id recording who created them. Keys die
// with their creator's account (they're a personal credential); sources are a
// county asset and survive staff turnover.
module.exports = {
  version: "006_document_integrations",
  name: "add county API keys and monitored document sources",
  up: async (db) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS county_api_keys (
        id BIGSERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        county TEXT NOT NULL,
        state TEXT NOT NULL,
        label TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT
      );
    `);
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_county_api_keys_county ON county_api_keys(LOWER(county), LOWER(state))",
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS document_sources (
        id BIGSERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        county TEXT NOT NULL,
        state TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        check_interval_hours INTEGER NOT NULL DEFAULT 24,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_checked_at BIGINT,
        last_status TEXT,
        last_error TEXT,
        last_new_count INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );
    `);
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_document_sources_due ON document_sources(active, last_checked_at)",
    );
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_sources_unique_url
      ON document_sources (LOWER(county), LOWER(state), url);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS source_documents (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        source_name TEXT,
        content_hash TEXT,
        etag TEXT,
        last_modified TEXT,
        last_error TEXT,
        first_seen_at BIGINT NOT NULL,
        last_checked_at BIGINT,
        last_ingested_at BIGINT,
        UNIQUE (source_id, url)
      );
    `);
  },
};
