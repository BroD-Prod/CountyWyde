const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureSchemaMigrationsTable(db) {
    await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function getAppliedMigrations(db) {
    await ensureSchemaMigrationsTable(db);
    const result = await db.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    return result.rows.map((row) => row.version);
}

async function runMigrations({ db, migrations = [] }) {
    await ensureSchemaMigrationsTable(db);
    const appliedVersions = await getAppliedMigrations(db);

    for (const migration of migrations) {
        if (appliedVersions.includes(migration.version)) {
            console.log(`[migrations] Skipping already-applied migration ${migration.version}`);
            continue;
        }

        const migrationLabel = `${migration.version} (${migration.name || 'unnamed'})`;
        console.log(`[migrations] Applying ${migrationLabel}`);

        try {
            if (typeof db.transaction === 'function') {
                await db.transaction(async (tx) => {
                    await migration.up(tx);
                    await tx.query(
                        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                        [migration.version, migration.name],
                    );
                });
            } else {
                await db.query('BEGIN');
                try {
                    await migration.up(db);
                    await db.query(
                        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                        [migration.version, migration.name],
                    );
                    await db.query('COMMIT');
                } catch (error) {
                    await db.query('ROLLBACK');
                    throw error;
                }
            }

            console.log(`[migrations] Completed ${migrationLabel}`);
            appliedVersions.push(migration.version);
        } catch (error) {
            console.error(`[migrations] Failed ${migrationLabel}`);
            console.error(`[migrations] ${error && error.message ? error.message : error}`);
            const version = migration.version;
            try {
                await db.query('DELETE FROM schema_migrations WHERE version = ?', [version]);
            } catch (cleanupError) {
                console.error('[migrations] Failed to clean up schema_migrations for failed migration:', cleanupError);
            }
            throw error;
        }
    }

    return appliedVersions;
}

async function loadMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        return [];
    }

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.js'))
        .sort((a, b) => a.localeCompare(b));

    return files.map((file) => {
        const migration = require(path.join(MIGRATIONS_DIR, file));
        return migration;
    });
}

module.exports = {
    ensureSchemaMigrationsTable,
    getAppliedMigrations,
    runMigrations,
    loadMigrationFiles,
};
