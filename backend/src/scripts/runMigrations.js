require('dotenv').config();
const { loadMigrationFiles, runMigrations } = require('../lib/migrations');
const db = require('../lib/db');

async function main() {
    const migrations = await loadMigrationFiles();
    await runMigrations({ db, migrations });
    console.log('Database migrations completed.');
}

main().catch((error) => {
    console.error('Database migration failed:', error);
    process.exitCode = 1;
});
