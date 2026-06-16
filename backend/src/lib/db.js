const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "../../data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "app.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const STATES = [
  { name: "Alabama", abbreviation: "AL" },
  { name: "Alaska", abbreviation: "AK" },
  { name: "Arizona", abbreviation: "AZ" },
  { name: "Arkansas", abbreviation: "AR" },
  { name: "California", abbreviation: "CA" },
  { name: "Colorado", abbreviation: "CO" },
  { name: "Connecticut", abbreviation: "CT" },
  { name: "Delaware", abbreviation: "DE" },
  { name: "Florida", abbreviation: "FL" },
  { name: "Georgia", abbreviation: "GA" },
  { name: "Hawaii", abbreviation: "HI" },
  { name: "Idaho", abbreviation: "ID" },
  { name: "Illinois", abbreviation: "IL" },
  { name: "Indiana", abbreviation: "IN" },
  { name: "Iowa", abbreviation: "IA" },
  { name: "Kansas", abbreviation: "KS" },
  { name: "Kentucky", abbreviation: "KY" },
  { name: "Louisiana", abbreviation: "LA" },
  { name: "Maine", abbreviation: "ME" },
  { name: "Maryland", abbreviation: "MD" },
  { name: "Massachusetts", abbreviation: "MA" },
  { name: "Michigan", abbreviation: "MI" },
  { name: "Minnesota", abbreviation: "MN" },
  { name: "Mississippi", abbreviation: "MS" },
  { name: "Missouri", abbreviation: "MO" },
  { name: "Montana", abbreviation: "MT" },
  { name: "Nebraska", abbreviation: "NE" },
  { name: "Nevada", abbreviation: "NV" },
  { name: "New Hampshire", abbreviation: "NH" },
  { name: "New Jersey", abbreviation: "NJ" },
  { name: "New Mexico", abbreviation: "NM" },
  { name: "New York", abbreviation: "NY" },
  { name: "North Carolina", abbreviation: "NC" },
  { name: "North Dakota", abbreviation: "ND" },
  { name: "Ohio", abbreviation: "OH" },
  { name: "Oklahoma", abbreviation: "OK" },
  { name: "Oregon", abbreviation: "OR" },
  { name: "Pennsylvania", abbreviation: "PA" },
  { name: "Rhode Island", abbreviation: "RI" },
  { name: "South Carolina", abbreviation: "SC" },
  { name: "South Dakota", abbreviation: "SD" },
  { name: "Tennessee", abbreviation: "TN" },
  { name: "Texas", abbreviation: "TX" },
  { name: "Utah", abbreviation: "UT" },
  { name: "Vermont", abbreviation: "VT" },
  { name: "Virginia", abbreviation: "VA" },
  { name: "Washington", abbreviation: "WA" },
  { name: "West Virginia", abbreviation: "WV" },
  { name: "Wisconsin", abbreviation: "WI" },
  { name: "Wyoming", abbreviation: "WY" },
];

function createCoreTables() {
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

  db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
  );`);
}

function seedStates() {
  const insertState = db.prepare(
    "INSERT OR IGNORE INTO states (name, abbreviation) VALUES (?, ?)",
  );
  const insertStates = db.transaction((states) => {
    for (const state of states) {
      insertState.run(state.name, state.abbreviation);
    }
  });
  insertStates(STATES);
}

function migrateAccountsTable() {
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all();
  const hasCountyColumn = accountColumns.some(
    (column) => column.name === "county",
  );
  const hasStateIdColumn = accountColumns.some(
    (column) => column.name === "state_id",
  );
  const hasLegacyStateColumn = accountColumns.some(
    (column) => column.name === "state",
  );
  const hasApprovedColumn = accountColumns.some(
    (column) => column.name === "approved",
  );

  if (!hasCountyColumn) {
    db.exec("ALTER TABLE accounts ADD COLUMN county TEXT;");
    db.exec(
      "UPDATE accounts SET county = 'Unknown County' WHERE county IS NULL OR TRIM(county) = '';",
    );
  }

  if (!hasStateIdColumn) {
    db.exec("ALTER TABLE accounts ADD COLUMN state_id INTEGER;");
  }

  if (!hasApprovedColumn) {
    db.exec("ALTER TABLE accounts ADD COLUMN approved INTEGER;");
    db.exec("UPDATE accounts SET approved = 1 WHERE approved IS NULL;");
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

  const defaultStateId =
    db.prepare("SELECT id FROM states WHERE abbreviation = 'AL' LIMIT 1").get()
      ?.id || 1;
  db.prepare("UPDATE accounts SET state_id = ? WHERE state_id IS NULL").run(
    defaultStateId,
  );
}

function createTranscriptionTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      county TEXT NOT NULL,
      state_id INTEGER NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      storage_key_or_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES accounts(id),
      FOREIGN KEY (state_id) REFERENCES states(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcription_jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL,
      engine TEXT NOT NULL,
      model_name TEXT NOT NULL,
      language TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_segments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      start_sec REAL NOT NULL CHECK (start_sec >= 0),
      end_sec REAL NOT NULL CHECK (end_sec >= start_sec),
      text TEXT NOT NULL,
      confidence_avg REAL,
      no_speech_prob REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES transcription_jobs(id) ON DELETE CASCADE,
      UNIQUE (job_id, segment_index)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      county TEXT NOT NULL,
      state_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      content TEXT NOT NULL,
      raw_content TEXT,
      start_sec_min REAL NOT NULL CHECK (start_sec_min >= 0),
      end_sec_max REAL NOT NULL CHECK (end_sec_max >= start_sec_min),
      source TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL CHECK (embedding_dim > 0),
      milvus_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES transcription_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES accounts(id),
      FOREIGN KEY (state_id) REFERENCES states(id),
      UNIQUE (job_id, chunk_index)
    );
  `);
}

function createIndexes() {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_accounts_state_id ON accounts(state_id);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);",
  );

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_uploads_state_county_status ON uploads(state_id, county, status);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_uploads_status_created_at ON uploads(status, created_at);",
  );

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jobs_upload_id ON transcription_jobs(upload_id);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON transcription_jobs(status, created_at);",
  );

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_segments_upload_segment ON transcript_segments(upload_id, segment_index);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_segments_job_segment ON transcript_segments(job_id, segment_index);",
  );

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chunks_state_county ON transcript_chunks(state_id, county);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chunks_upload_chunk ON transcript_chunks(upload_id, chunk_index);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chunks_user_created_at ON transcript_chunks(user_id, created_at);",
  );
}

function initializeDb() {
  createCoreTables();
  seedStates();
  migrateAccountsTable();
  createTranscriptionTables();
  createIndexes();
}

initializeDb();

module.exports = db;
