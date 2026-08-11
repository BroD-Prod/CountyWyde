module.exports = {
  version: "002_account_auth_support",
  name: "add account auth support tables",
  up: async (db) => {
    await db.query(
      "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE",
    );
    await db.query(
      "UPDATE accounts SET must_change_password = FALSE WHERE must_change_password IS NULL",
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS account_2fa_challenges (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        challenge_token_hash TEXT UNIQUE NOT NULL,
        otp_hash TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_sent_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        consumed_at BIGINT,
        FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS account_password_reset_tokens (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        reset_token_hash TEXT UNIQUE NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        consumed_at BIGINT,
        FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS account_creation_requests (
        id BIGSERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        county TEXT NOT NULL,
        state_id INTEGER NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
        account_id INTEGER,
        review_notes TEXT,
        reviewed_at BIGINT,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (state_id) REFERENCES states(id),
        FOREIGN KEY (account_id) REFERENCES accounts(id)
      );
    `);

    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_2fa_user_id_expires_at ON account_2fa_challenges(user_id, expires_at)",
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_password_reset_user_id_expires_at ON account_password_reset_tokens(user_id, expires_at)",
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_account_requests_status_created ON account_creation_requests(status, created_at)",
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS idx_account_requests_email_status ON account_creation_requests(email, status)",
    );
  },
};
