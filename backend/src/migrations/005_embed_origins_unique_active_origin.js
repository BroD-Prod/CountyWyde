module.exports = {
    version: "005_embed_origins_unique_active_origin",
    name: "enforce a single active embed_origins row per origin",
    up: async (db) => {
        await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_embed_origins_unique_active_origin
      ON embed_origins (origin)
      WHERE revoked = FALSE;
    `);
    },
};
