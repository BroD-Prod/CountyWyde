module.exports = {
    version: "004_add_embed_origins",
    name: "add embed_origins table for iframe county locking",
    up: async (db) => {
        await db.query(`
      CREATE TABLE IF NOT EXISTS embed_origins (
        id BIGSERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        origin TEXT NOT NULL,
        state TEXT NOT NULL,
        county TEXT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL
      );
    `);

        await db.query(
            "CREATE INDEX IF NOT EXISTS idx_embed_origins_revoked ON embed_origins(revoked)",
        );
    },
};
