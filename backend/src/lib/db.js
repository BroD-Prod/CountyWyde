const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    abbreviation TEXT UNIQUE NOT NULL
);`);

db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        county TEXT NOT NULL,
        state_id INTEGER,
        approved INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (state_id) REFERENCES states(id)
    );
`);

const states = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana',
    'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
    'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
    'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
    'New Mexico', 'New York', 'North Carolina', 'North Dakota',
    'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
    'South Carolina', 'South Dakota', 'Tennessee', 'Texas',
    'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming'
];

const statesAbbreviations = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT',
    'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
    'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO',
    'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND',
    'OH', 'OK', 'OR', 'PA', 'RI',
    'SC', 'SD', 'TN', 'TX',
    'UT', 'VT', 'VA', 'WA',
    'WV', 'WI', 'WY'
];

const insertState = db.prepare("INSERT OR IGNORE INTO states (name, abbreviation) VALUES (?, ?)");
const insertStates = db.transaction((states, abbreviations) => {
    for (let i = 0; i < states.length; i++) {
        insertState.run(states[i], abbreviations[i]);
    }
});
insertStates(states, statesAbbreviations);

const accountColumns = db.prepare("PRAGMA table_info(accounts)").all();
const hasCountyColumn = accountColumns.some((column) => column.name === 'county');
const hasStateIdColumn = accountColumns.some((column) => column.name === 'state_id');
const hasLegacyStateColumn = accountColumns.some((column) => column.name === 'state');
const hasApprovedColumn = accountColumns.some((column) => column.name === 'approved');

if (!hasCountyColumn) {
    db.exec('ALTER TABLE accounts ADD COLUMN county TEXT;');
    db.exec("UPDATE accounts SET county = 'Unknown County' WHERE county IS NULL OR TRIM(county) = '';");
}
if (!hasStateIdColumn) {
    db.exec('ALTER TABLE accounts ADD COLUMN state_id INTEGER;');
}

if (!hasApprovedColumn) {
    db.exec('ALTER TABLE accounts ADD COLUMN approved INTEGER;');
    db.exec('UPDATE accounts SET approved = 1 WHERE approved IS NULL;');
}

if (hasLegacyStateColumn) {
    db.exec(`
        UPDATE accounts
        SET state_id = (
            SELECT s.id
            FROM states s
            WHERE LOWER(s.name) = LOWER(accounts.state)
               OR UPPER(s.abbreviation) = UPPER(accounts.state)
            LIMIT 1
        )
        WHERE state_id IS NULL;
    `);
}

const defaultStateId = db.prepare("SELECT id FROM states WHERE abbreviation = 'AL' LIMIT 1").get()?.id || 1;
db.prepare('UPDATE accounts SET state_id = ? WHERE state_id IS NULL').run(defaultStateId);
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_state_id ON accounts(state_id);');

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);`)

module.exports = db;