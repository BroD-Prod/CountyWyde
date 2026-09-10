module.exports = {
    version: "003_add_admin_column",
    name: "add is_admin column to accounts table",
    up: async (db) => {
        await db.query(
            "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE"
        );
        await db.query(
            "UPDATE accounts SET is_admin = FALSE WHERE is_admin IS NULL"
        );
    },
};
