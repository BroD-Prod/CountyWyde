const { Pool } = require("pg");
const { loadMigrationFiles, runMigrations } = require("./migrations");

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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable for PostgreSQL");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSL === "require" || process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

function convertSqlPlaceholders(sql) {
  let index = 1;
  let out = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "'" && !inDoubleQuote) {
      if (inSingleQuote && next === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      out += char;
      continue;
    }

    if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      out += `$${index}`;
      index += 1;
      continue;
    }

    out += char;
  }

  return out;
}

async function rawQuery(sql, params = [], client = pool) {
  return client.query(convertSqlPlaceholders(sql), params);
}

async function createCoreTables() {
  await rawQuery(`
    CREATE TABLE IF NOT EXISTS states (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      abbreviation TEXT UNIQUE NOT NULL
    );
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      county TEXT NOT NULL,
      state_id INTEGER,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      FOREIGN KEY (state_id) REFERENCES states(id)
    );
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
}

async function seedStates() {
  for (const state of STATES) {
    await rawQuery(
      "INSERT INTO states (name, abbreviation) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [state.name, state.abbreviation],
    );
  }
}

async function migrateAccountsTable() {
  await rawQuery("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS county TEXT");
  await rawQuery(
    "UPDATE accounts SET county = 'Unknown County' WHERE county IS NULL OR TRIM(county) = ''",
  );

  await rawQuery(
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS state_id INTEGER",
  );
  await rawQuery(
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE",
  );
  await rawQuery(
    "UPDATE accounts SET approved = TRUE WHERE approved IS NULL",
  );

  const defaultState = await rawQuery(
    "SELECT id FROM states WHERE abbreviation = 'AL' LIMIT 1",
  );
  const defaultStateId = defaultState.rows[0]?.id || 1;
  await rawQuery("UPDATE accounts SET state_id = ? WHERE state_id IS NULL", [
    defaultStateId,
  ]);
}

async function createTranscriptionTables() {
  await rawQuery(`
    CREATE TABLE IF NOT EXISTS uploads(
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      county TEXT NOT NULL,
      state_id INTEGER NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      storage_key_or_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
      duration_seconds DOUBLE PRECISION CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES accounts(id),
      FOREIGN KEY (state_id) REFERENCES states(id)
    );
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS transcription_jobs(
      id BIGSERIAL PRIMARY KEY,
      upload_id BIGINT NOT NULL,
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

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS transcript_segments(
      id BIGSERIAL PRIMARY KEY,
      upload_id BIGINT NOT NULL,
      job_id BIGINT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      start_sec DOUBLE PRECISION NOT NULL CHECK (start_sec >= 0),
      end_sec DOUBLE PRECISION NOT NULL CHECK (end_sec >= start_sec),
      text TEXT NOT NULL,
      confidence_avg DOUBLE PRECISION,
      no_speech_prob DOUBLE PRECISION,
      created_at TEXT NOT NULL,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES transcription_jobs(id) ON DELETE CASCADE,
      UNIQUE (job_id, segment_index)
    );
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS transcript_chunks(
      id BIGSERIAL PRIMARY KEY,
      upload_id BIGINT NOT NULL,
      job_id BIGINT NOT NULL,
      user_id INTEGER NOT NULL,
      county TEXT NOT NULL,
      state_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      content TEXT NOT NULL,
      raw_content TEXT,
      start_sec_min DOUBLE PRECISION NOT NULL CHECK (start_sec_min >= 0),
      end_sec_max DOUBLE PRECISION NOT NULL CHECK (end_sec_max >= start_sec_min),
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

async function createIndexes() {
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_accounts_state_id ON accounts(state_id)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
  );

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_uploads_state_county_status ON uploads(state_id, county, status)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_uploads_status_created_at ON uploads(status, created_at)",
  );

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_jobs_upload_id ON transcription_jobs(upload_id)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON transcription_jobs(status, created_at)",
  );

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_segments_upload_segment ON transcript_segments(upload_id, segment_index)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_segments_job_segment ON transcript_segments(job_id, segment_index)",
  );

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_chunks_state_county ON transcript_chunks(state_id, county)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_chunks_upload_chunk ON transcript_chunks(upload_id, chunk_index)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_chunks_user_created_at ON transcript_chunks(user_id, created_at)",
  );
}

async function createUploadChunksTable() {
  await rawQuery(`
    CREATE TABLE IF NOT EXISTS upload_chunks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      text TEXT NOT NULL,
      parsed_type TEXT NOT NULL DEFAULT 'text',
      metadata TEXT,
      structured TEXT,
      county TEXT NOT NULL,
      state TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 1,
      row_index INTEGER,
      document_id TEXT,
      original_file_name TEXT,
      original_mime_type TEXT,
      original_size BIGINT,
      original_stored_filename TEXT,
      original_stored_path TEXT,
      original_stored_at TEXT,
      embedding TEXT,
      created_at TEXT NOT NULL
    );
  `);

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_upload_chunks_county_state ON upload_chunks(county, state)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_upload_chunks_document_id ON upload_chunks(document_id)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_upload_chunks_source_county ON upload_chunks(source, county)",
  );
}

async function createSecurityTables() {
  await rawQuery(`
    CREATE TABLE IF NOT EXISTS security_rate_limits (
      ip TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      count INTEGER NOT NULL,
      reset_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (ip, method, path)
    )
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS security_blocks (
      ip TEXT PRIMARY KEY,
      blocked_until BIGINT NOT NULL,
      reason TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await rawQuery(`
    CREATE TABLE IF NOT EXISTS security_suspicion (
      ip TEXT PRIMARY KEY,
      score INTEGER NOT NULL,
      reset_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);

  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_security_rate_limits_reset_at ON security_rate_limits(reset_at)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_security_blocks_blocked_until ON security_blocks(blocked_until)",
  );
  await rawQuery(
    "CREATE INDEX IF NOT EXISTS idx_security_suspicion_reset_at ON security_suspicion(reset_at)",
  );
}

async function initializeDb() {
  const migrationDb = {
    query: (sql, params = []) => rawQuery(sql, params),
  };

  const migrations = await loadMigrationFiles();
  await runMigrations({ db: migrationDb, migrations });
}

const ready = initializeDb();

async function query(sql, params = []) {
  await ready;
  return rawQuery(sql, params);
}

async function exec(sql, params = []) {
  await query(sql, params);
}

async function get(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function run(sql, params = []) {
  const result = await query(sql, params);
  return {
    changes: result.rowCount,
    rows: result.rows,
  };
}

function prepare(sql) {
  return {
    get: (...params) => get(sql, params),
    all: (...params) => all(sql, params),
    run: (...params) => run(sql, params),
  };
}

async function transaction(work) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tx = {
      query: (sql, params = []) => rawQuery(sql, params, client),
      exec: (sql, params = []) => rawQuery(sql, params, client).then(() => { }),
      get: async (sql, params = []) => {
        const result = await rawQuery(sql, params, client);
        return result.rows[0] || null;
      },
      all: async (sql, params = []) => {
        const result = await rawQuery(sql, params, client);
        return result.rows;
      },
      run: async (sql, params = []) => {
        const result = await rawQuery(sql, params, client);
        return {
          changes: result.rowCount,
          rows: result.rows,
        };
      },
    };

    const result = await work(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  ready,
  query,
  exec,
  get,
  all,
  run,
  prepare,
  transaction,
};
