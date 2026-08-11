const test = require('node:test');
const assert = require('node:assert/strict');

const { runMigrations } = require('../src/lib/migrations');

test('runMigrations applies each migration once and records its version', async () => {
    const appliedVersions = [];
    const executed = [];

    const fakeDb = {
        async query(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

            if (normalized.startsWith('create table if not exists schema_migrations')) {
                return { rows: [] };
            }

            if (normalized.startsWith('select version from schema_migrations')) {
                return {
                    rows: appliedVersions.map((version) => ({ version })),
                };
            }

            if (normalized.startsWith('insert into schema_migrations')) {
                const version = Array.isArray(params) && params[0] ? params[0] : null;
                if (version) {
                    appliedVersions.push(version);
                }
                return { rowCount: 1, rows: [] };
            }

            if (normalized.startsWith('delete from schema_migrations')) {
                return { rowCount: 1, rows: [] };
            }

            return { rows: [] };
        },
        async transaction(work) {
            return work(this);
        },
    };

    const migrations = [
        {
            version: '001_initial_schema',
            name: 'initial schema',
            up: async () => {
                executed.push('001_initial_schema');
            },
        },
    ];

    await runMigrations({ db: fakeDb, migrations });
    await runMigrations({ db: fakeDb, migrations });

    assert.deepEqual(executed, ['001_initial_schema']);
    assert.deepEqual(appliedVersions, ['001_initial_schema']);
});
