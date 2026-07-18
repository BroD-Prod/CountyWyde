const bcrypt = require("bcrypt");
const crypto = require("crypto");
const db = require("../lib/db");
const security = require("../lib/security");
const { sendTwoFactorEmail, sendPasswordResetEmail } = require("../lib/email");
const helperController = require("./helperController");
const {
  normalizeCounty,
  isCountyFormatValid,
  getRegisteredCounties,
  getRegisteredStates,
} = require("../lib/countyRegistry");

const SALT_ROUNDS = 12;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const SESSION_MAX_AGE_SECONDS = 86400;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const TWO_FACTOR_COOKIE_MAX_AGE_SECONDS = 15 * 60;
const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_RESEND_COOLDOWN_MS = 45 * 1000;
const TWO_FACTOR_CODE_LENGTH = 6;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_LIMIT = 10;
const SIGNUP_RATE_LIMIT = 10;
const DELETE_RATE_LIMIT = 10;
const UPDATE_RATE_LIMIT = 30;
const CHANGE_PASSWORD_RATE_LIMIT = 20;
const FORGOT_PASSWORD_RATE_LIMIT = 10;
const RESET_PASSWORD_RATE_LIMIT = 10;
const rateWindow = new Map();

function getClientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(req, bucket, limit, res) {
  const now = Date.now();
  const key = `${bucket}:${getClientIp(req)}`;
  const state = rateWindow.get(key);

  if (!state || state.resetAt <= now) {
    rateWindow.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  state.count += 1;
  if (state.count > limit) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: "Too many requests, please retry shortly" }),
    );
    return true;
  }

  return false;
}

function buildSessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `session_token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

function buildClearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `session_token=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict${secure}`;
}

function buildTwoFactorCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `two_factor_token=${token}; HttpOnly; Path=/; Max-Age=${TWO_FACTOR_COOKIE_MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

function buildClearTwoFactorCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `two_factor_token=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict${secure}`;
}

function generateOtpCode() {
  const min = 10 ** (TWO_FACTOR_CODE_LENGTH - 1);
  const max = 10 ** TWO_FACTOR_CODE_LENGTH;
  return String(crypto.randomInt(min, max));
}

function getTwoFactorTokenFromRequest(req) {
  const cookies = helperController.parseCookies(req.headers.cookie);
  return String(cookies.two_factor_token || "").trim();
}

async function sendTwoFactorCode({ recipient, code }) {
  const recipientEmail = String(recipient || "").trim();
  const isLikelyEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail);
  if (!isLikelyEmail) {
    throw new Error("2FA recipient is not a valid email address");
  }

  const preferSes = String(process.env.TWO_FACTOR_DELIVERY_PROVIDER || "ses")
    .trim()
    .toLowerCase();

  if (preferSes === "ses") {
    try {
      await sendTwoFactorEmail({
        toEmail: recipientEmail,
        code,
        ttlMinutes: Math.round(TWO_FACTOR_TTL_MS / 60000),
      });
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        throw error;
      }

      console.warn(
        `[2fa] SES delivery failed in non-production; falling back to console output: ${error.message}`,
      );
      console.info(`[2fa] verification code for ${recipientEmail}: ${code}`);
    }
    return;
  }

  const webhookUrl = String(
    process.env.TWO_FACTOR_DELIVERY_WEBHOOK_URL ||
    process.env.EMAIL_DELIVERY_WEBHOOK_URL ||
    "",
  ).trim();

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "two_factor_code",
        recipient,
        code,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to deliver verification code");
    }

    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("Two-factor delivery is not configured");
  }

  console.info(`[2fa] verification code for ${recipientEmail}: ${code}`);
}

function normalizeState(value) {
  return String(value || "").trim();
}

function resolveState(input) {
  const stateInput = normalizeState(input);
  if (!stateInput) {
    return null;
  }

  return db
    .prepare(
      "SELECT id, name, abbreviation FROM states WHERE LOWER(name) = LOWER(?) OR UPPER(abbreviation) = UPPER(?) LIMIT 1",
    )
    .get(stateInput, stateInput);
}

function generateTemporaryPassword(length = 16) {
  const bytesNeeded = Math.ceil(length * 0.75);
  return crypto
    .randomBytes(bytesNeeded)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, Math.max(length, 12));
}

async function requestAccountAccess(req, res) {
  if (checkRateLimit(req, "request-account-access", 10, res)) {
    return;
  }

  try {
    const { fullName, name, email, county, state, notes } =
      await helperController.parseJsonBody(req, MAX_JSON_BYTES);

    const requestorName = String(fullName || name || "").trim();
    const requestorEmail = String(email || "")
      .trim()
      .toLowerCase();
    const selectedCounty = normalizeCounty(county);
    const selectedState = resolveState(state);
    const requestNotes = String(notes || "").trim();

    if (!requestorName || !requestorEmail || !selectedCounty || !state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Name, email, county, and state are required",
        }),
      );
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestorEmail)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please provide a valid email" }));
      return;
    }

    if (!isCountyFormatValid(selectedCounty)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please enter a valid county name" }));
      return;
    }

    if (!selectedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please select a valid state" }));
      return;
    }

    const existingPending = db
      .prepare(
        `SELECT id
         FROM account_creation_requests
         WHERE LOWER(email) = LOWER(?)
           AND county = ?
           AND state_id = ?
           AND status = 'pending'
         LIMIT 1`,
      )
      .get(requestorEmail, selectedCounty, selectedState.id);

    if (existingPending) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "An account request is already pending for this county/email",
        }),
      );
      return;
    }

    const existingAccount = db
      .prepare("SELECT id FROM accounts WHERE LOWER(username) = LOWER(?) LIMIT 1")
      .get(requestorEmail);
    if (existingAccount) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "An account already exists for this email" }));
      return;
    }

    db.prepare(
      `INSERT INTO account_creation_requests (
        full_name, email, county, state_id, notes, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      requestorName,
      requestorEmail,
      selectedCounty,
      selectedState.id,
      requestNotes || null,
      Date.now(),
    );

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message:
          "Account request submitted. Your county request is now pending review.",
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function createAccount(req, res) {
  if (checkRateLimit(req, "signup", SIGNUP_RATE_LIMIT, res)) {
    return;
  }

  try {
    const { username, password, county, state } =
      await helperController.parseJsonBody(req, MAX_JSON_BYTES);
    const normalizedUsername = String(username || "")
      .trim()
      .toLowerCase();
    const selectedCounty = normalizeCounty(county);
    const selectedState = resolveState(state);

    if (!normalizedUsername || !password || !selectedCounty || !state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Username, password, county, and state are required",
        }),
      );
      return;
    }

    if (!isCountyFormatValid(selectedCounty)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please enter a valid county name" }));
      return;
    }

    if (!selectedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please select a valid state" }));
      return;
    }

    const existing = db
      .prepare("SELECT 1 FROM accounts WHERE LOWER(username) = LOWER(?) LIMIT 1")
      .get(normalizedUsername);
    if (existing) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Username already exists" }));
      return;
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    db.prepare(
      "INSERT INTO accounts (username, password_hash, county, state_id, approved) VALUES (?, ?, ?, ?, 0)",
    ).run(normalizedUsername, hashedPassword, selectedCounty, selectedState.id);

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: "Signup received. Your account is pending approval.",
        approved: false,
        county: selectedCounty,
        state: {
          name: selectedState.name,
          abbreviation: selectedState.abbreviation,
        },
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function deleteAccount(req, res) {
  if (checkRateLimit(req, "delete-account", DELETE_RATE_LIMIT, res)) {
    return;
  }

  const authUser = helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!authUser) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "You must be signed in" }));
    return;
  }

  try {
    const { username, password } = await helperController.parseJsonBody(
      req,
      MAX_JSON_BYTES,
    );

    if (!password) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Password is required" }));
      return;
    }

    if (username && username !== authUser.username) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const existing = db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(authUser.id);
    if (!existing) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Account not found" }));
      return;
    }

    const validPassword = await bcrypt.compare(
      password,
      existing.password_hash,
    );
    if (!validPassword) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid password" }));
      return;
    }

    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(existing.id);

    res.setHeader("Set-Cookie", buildClearSessionCookie());
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ message: `Account deleted for ${existing.username}` }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function login(req, res) {
  if (checkRateLimit(req, "login", LOGIN_RATE_LIMIT, res)) {
    return;
  }

  try {
    const { username, password } = await helperController.parseJsonBody(
      req,
      MAX_JSON_BYTES,
    );

    const normalizedUsername = String(username || "").trim();
    const normalizedPassword = String(password || "");

    if (!normalizedUsername || !normalizedPassword) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Username and password are required" }));
      return;
    }

    const account = db
      .prepare(
        `SELECT *
         FROM accounts
         WHERE username = ?
            OR LOWER(username) = LOWER(?)
         LIMIT 1`,
      )
      .get(normalizedUsername, normalizedUsername);
    if (!account) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid credentials" }));
      return;
    }

    const validPassword = await bcrypt.compare(
      normalizedPassword,
      account.password_hash,
    );
    if (!validPassword) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid credentials" }));
      return;
    }

    if (!account.approved) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Your account is pending approval" }));
      return;
    }

    const twoFactorToken = crypto.randomBytes(48).toString("hex");
    const challengeTokenHash = helperController.hashToken(twoFactorToken);
    const code = generateOtpCode();
    const now = Date.now();
    const expiresAt = now + TWO_FACTOR_TTL_MS;

    db.prepare(
      "DELETE FROM account_2fa_challenges WHERE user_id = ? OR expires_at <= ?",
    ).run(account.id, now);

    db.prepare(
      `INSERT INTO account_2fa_challenges (
        user_id, challenge_token_hash, otp_hash, expires_at, attempt_count,
        max_attempts, last_sent_at, created_at, consumed_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
    ).run(
      account.id,
      challengeTokenHash,
      helperController.hashToken(code),
      expiresAt,
      TWO_FACTOR_MAX_ATTEMPTS,
      now,
      now,
    );

    await sendTwoFactorCode({ recipient: account.username, code });

    res.setHeader("Set-Cookie", buildTwoFactorCookie(twoFactorToken));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: "Verification code sent. Complete 2FA to sign in.",
        requiresTwoFactor: true,
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function verifyTwoFactor(req, res) {
  if (checkRateLimit(req, "two-factor-verify", 30, res)) {
    return;
  }

  const twoFactorToken = getTwoFactorTokenFromRequest(req);
  if (!twoFactorToken) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
    res.end(JSON.stringify({ error: "2FA challenge is missing or expired" }));
    return;
  }

  try {
    const { code } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
    const candidateCode = String(code || "").trim();

    if (!/^\d{6}$/.test(candidateCode)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "A valid 6-digit code is required" }));
      return;
    }

    const now = Date.now();
    const challengeTokenHash = helperController.hashToken(twoFactorToken);
    const challenge = db
      .prepare(
        `SELECT c.*, a.username, a.must_change_password
         FROM account_2fa_challenges c
         JOIN accounts a ON a.id = c.user_id
         WHERE c.challenge_token_hash = ?
         LIMIT 1`,
      )
      .get(challengeTokenHash);

    if (!challenge || challenge.consumed_at || challenge.expires_at <= now) {
      db.prepare(
        "DELETE FROM account_2fa_challenges WHERE challenge_token_hash = ? OR expires_at <= ?",
      ).run(challengeTokenHash, now);
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
      res.end(JSON.stringify({ error: "2FA challenge is missing or expired" }));
      return;
    }

    if (challenge.attempt_count >= challenge.max_attempts) {
      db.prepare(
        "UPDATE account_2fa_challenges SET consumed_at = ? WHERE id = ?",
      ).run(now, challenge.id);
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
      res.end(JSON.stringify({ error: "Too many invalid code attempts" }));
      return;
    }

    const codeHash = helperController.hashToken(candidateCode);
    if (codeHash !== challenge.otp_hash) {
      const nextAttempts = challenge.attempt_count + 1;
      db.prepare(
        "UPDATE account_2fa_challenges SET attempt_count = ? WHERE id = ?",
      ).run(nextAttempts, challenge.id);

      if (nextAttempts >= challenge.max_attempts) {
        db.prepare(
          "UPDATE account_2fa_challenges SET consumed_at = ? WHERE id = ?",
        ).run(now, challenge.id);
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
        res.end(JSON.stringify({ error: "Too many invalid code attempts" }));
        return;
      }

      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid verification code" }));
      return;
    }

    db.prepare(
      "UPDATE account_2fa_challenges SET consumed_at = ? WHERE id = ?",
    ).run(now, challenge.id);

    const sessionToken = crypto.randomBytes(64).toString("hex");
    const tokenHash = helperController.hashToken(sessionToken);
    const sessionExpiresAt = now + SESSION_MAX_AGE_MS;

    db.prepare(
      "INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(challenge.user_id, tokenHash, sessionExpiresAt, now);

    res.setHeader("Set-Cookie", [
      buildSessionCookie(sessionToken),
      buildClearTwoFactorCookie(),
    ]);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: `Login successful for ${challenge.username}`,
        requiresPasswordChange: Boolean(challenge.must_change_password),
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function changePassword(req, res) {
  if (checkRateLimit(req, "change-password", CHANGE_PASSWORD_RATE_LIMIT, res)) {
    return;
  }

  const authUser = helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!authUser) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "You must be signed in" }));
    return;
  }

  try {
    const { currentPassword, newPassword } = await helperController.parseJsonBody(
      req,
      MAX_JSON_BYTES,
    );

    const current = String(currentPassword || "");
    const next = String(newPassword || "");

    if (!current || !next) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: "Current password and new password are required" }),
      );
      return;
    }

    if (next.length < 10) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: "New password must be at least 10 characters" }),
      );
      return;
    }

    const account = db
      .prepare("SELECT id, password_hash FROM accounts WHERE id = ? LIMIT 1")
      .get(authUser.id);
    if (!account) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Account not found" }));
      return;
    }

    const validCurrentPassword = await bcrypt.compare(current, account.password_hash);
    if (!validCurrentPassword) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Current password is incorrect" }));
      return;
    }

    const sameAsCurrent = await bcrypt.compare(next, account.password_hash);
    if (sameAsCurrent) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "New password must be different from your current password",
        }),
      );
      return;
    }

    const hashedPassword = await bcrypt.hash(next, SALT_ROUNDS);
    db.prepare(
      "UPDATE accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    ).run(hashedPassword, authUser.id);

    db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(
      Date.now() + SESSION_MAX_AGE_MS,
      authUser.id,
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Password updated successfully" }));
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function requestPasswordReset(req, res) {
  if (
    checkRateLimit(req, "forgot-password", FORGOT_PASSWORD_RATE_LIMIT, res)
  ) {
    return;
  }

  const genericMessage =
    "If this email exists, a password reset link has been sent.";
  const isProduction = process.env.NODE_ENV === "production";

  try {
    const { email } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: genericMessage }));
      return;
    }

    const now = Date.now();
    db.prepare(
      "DELETE FROM account_password_reset_tokens WHERE expires_at <= ?",
    ).run(now);

    const account = db
      .prepare(
        `SELECT id, username
         FROM accounts
         WHERE approved = 1 AND LOWER(username) = LOWER(?)
         LIMIT 1`,
      )
      .get(normalizedEmail);

    let developmentResetUrl = null;

    if (account) {
      const resetToken = crypto.randomBytes(48).toString("hex");
      const resetTokenHash = helperController.hashToken(resetToken);
      const expiresAt = now + PASSWORD_RESET_TTL_MS;

      db.prepare(
        "DELETE FROM account_password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL",
      ).run(account.id);

      db.prepare(
        `INSERT INTO account_password_reset_tokens (
          user_id, reset_token_hash, expires_at, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, NULL)`,
      ).run(account.id, resetTokenHash, expiresAt, now);

      const frontendBaseUrl = String(
        process.env.FRONTEND_BASE_URL || "http://localhost:3000",
      )
        .trim()
        .replace(/\/$/, "");
      const resetUrl = `${frontendBaseUrl}/account/reset-password?token=${encodeURIComponent(resetToken)}`;
      if (!isProduction) {
        developmentResetUrl = resetUrl;
      }

      try {
        await sendPasswordResetEmail({
          toEmail: account.username,
          resetUrl,
          ttlMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60000),
        });
      } catch (error) {
        if (isProduction) {
          throw error;
        }

        console.warn(
          `[password-reset] email delivery failed in non-production: ${error.message}`,
        );
        console.info(`[password-reset] reset link for ${account.username}: ${resetUrl}`);
      }
    }

    const responseBody = { message: genericMessage };
    if (!isProduction && developmentResetUrl) {
      responseBody.resetUrl = developmentResetUrl;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responseBody));
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function resetPasswordWithToken(req, res) {
  if (
    checkRateLimit(req, "reset-password", RESET_PASSWORD_RATE_LIMIT, res)
  ) {
    return;
  }

  try {
    const { token, newPassword } = await helperController.parseJsonBody(
      req,
      MAX_JSON_BYTES,
    );

    const candidateToken = String(token || "").trim();
    const nextPassword = String(newPassword || "");

    if (!candidateToken || !nextPassword) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Token and new password are required" }));
      return;
    }

    if (nextPassword.length < 10) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: "New password must be at least 10 characters" }),
      );
      return;
    }

    const now = Date.now();
    const tokenHash = helperController.hashToken(candidateToken);
    const resetRecord = db
      .prepare(
        `SELECT r.id, r.user_id, a.password_hash
         FROM account_password_reset_tokens r
         JOIN accounts a ON a.id = r.user_id
         WHERE r.reset_token_hash = ?
           AND r.consumed_at IS NULL
           AND r.expires_at > ?
         LIMIT 1`,
      )
      .get(tokenHash, now);

    if (!resetRecord) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Reset link is invalid or expired" }));
      return;
    }

    const sameAsCurrent = await bcrypt.compare(
      nextPassword,
      resetRecord.password_hash,
    );
    if (sameAsCurrent) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "New password must be different from your current password",
        }),
      );
      return;
    }

    const hashedPassword = await bcrypt.hash(nextPassword, SALT_ROUNDS);
    db.prepare(
      "UPDATE accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    ).run(hashedPassword, resetRecord.user_id);

    db.prepare(
      "UPDATE account_password_reset_tokens SET consumed_at = ? WHERE id = ?",
    ).run(now, resetRecord.id);

    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(resetRecord.user_id);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Password reset successful" }));
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function resendTwoFactor(req, res) {
  if (checkRateLimit(req, "two-factor-resend", 10, res)) {
    return;
  }

  const twoFactorToken = getTwoFactorTokenFromRequest(req);
  if (!twoFactorToken) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
    res.end(JSON.stringify({ error: "2FA challenge is missing or expired" }));
    return;
  }

  try {
    const now = Date.now();
    const challengeTokenHash = helperController.hashToken(twoFactorToken);
    const challenge = db
      .prepare(
        `SELECT c.*, a.username
         FROM account_2fa_challenges c
         JOIN accounts a ON a.id = c.user_id
         WHERE c.challenge_token_hash = ?
         LIMIT 1`,
      )
      .get(challengeTokenHash);

    if (!challenge || challenge.consumed_at || challenge.expires_at <= now) {
      db.prepare(
        "DELETE FROM account_2fa_challenges WHERE challenge_token_hash = ? OR expires_at <= ?",
      ).run(challengeTokenHash, now);
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
      res.end(JSON.stringify({ error: "2FA challenge is missing or expired" }));
      return;
    }

    if (challenge.attempt_count >= challenge.max_attempts) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Set-Cookie", buildClearTwoFactorCookie());
      res.end(JSON.stringify({ error: "Too many invalid code attempts" }));
      return;
    }

    const elapsedMs = now - Number(challenge.last_sent_at || 0);
    if (elapsedMs < TWO_FACTOR_RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil(
        (TWO_FACTOR_RESEND_COOLDOWN_MS - elapsedMs) / 1000,
      );
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Retry-After", retryAfterSeconds);
      res.end(
        JSON.stringify({
          error: "Please wait before requesting another code",
          retryAfterSeconds,
        }),
      );
      return;
    }

    const code = generateOtpCode();
    db.prepare(
      `UPDATE account_2fa_challenges
       SET otp_hash = ?, expires_at = ?, attempt_count = 0, last_sent_at = ?
       WHERE id = ?`,
    ).run(helperController.hashToken(code), now + TWO_FACTOR_TTL_MS, now, challenge.id);

    await sendTwoFactorCode({ recipient: challenge.username, code });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "A new verification code was sent" }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: error.message || "Unable to resend verification code",
      }),
    );
  }
}

function getSession(req, res) {
  const authUser = helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!authUser) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ authenticated: false }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      authenticated: true,
      user: {
        id: authUser.id,
        username: authUser.username,
        county: authUser.county,
        mustChangePassword: Boolean(authUser.must_change_password),
        state: {
          name: authUser.state_name,
          abbreviation: authUser.state_abbreviation,
        },
      },
    }),
  );
}

function getAccount(req, res) {
  const authUser = helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!authUser) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "You must be signed in" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      account: authUser.username,
      county: authUser.county,
      mustChangePassword: Boolean(authUser.must_change_password),
      state: {
        name: authUser.state_name,
        abbreviation: authUser.state_abbreviation,
      },
    }),
  );
}

function getCounties(req, res) {
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const counties = getRegisteredCounties(
      requestUrl.searchParams.get("state"),
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ counties }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load counties" }));
  }
}

function getStates(req, res) {
  try {
    const states = getRegisteredStates();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ states }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load states" }));
  }
}

async function updateAccount(req, res) {
  if (checkRateLimit(req, "update-account", UPDATE_RATE_LIMIT, res)) {
    return;
  }

  const authUser = helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!authUser) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "You must be signed in" }));
    return;
  }

  try {
    const { county, state } = await helperController.parseJsonBody(
      req,
      MAX_JSON_BYTES,
    );
    const selectedCounty = normalizeCounty(county);
    const resolvedState = resolveState(state);

    if (!selectedCounty || !state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "County and state are required" }));
      return;
    }

    if (!isCountyFormatValid(selectedCounty)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please enter a valid county name" }));
      return;
    }

    if (!resolvedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Please select a valid state" }));
      return;
    }

    db.prepare("UPDATE accounts SET county = ?, state_id = ? WHERE id = ?").run(
      selectedCounty,
      resolvedState.id,
      authUser.id,
    );

    db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(
      Date.now() + SESSION_MAX_AGE_MS,
      authUser.id,
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: `Account updated for ${authUser.username}`,
        county: selectedCounty,
        state: {
          name: resolvedState.name,
          abbreviation: resolvedState.abbreviation,
        },
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

function isAdminRequest(req) {
  if (!ADMIN_KEY) return false;
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function getPendingAccounts(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.username, a.county, st.name AS state_name, st.abbreviation AS state_abbreviation
             FROM accounts a
             JOIN states st ON st.id = a.state_id
             WHERE a.approved = 0
             ORDER BY a.id ASC`,
      )
      .all();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ pending: rows }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load pending accounts" }));
  }
}

function getPendingAccountRequests(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  try {
    const rows = db
      .prepare(
        `SELECT r.id, r.full_name, r.email, r.county, r.notes, r.created_at,
                st.name AS state_name, st.abbreviation AS state_abbreviation
         FROM account_creation_requests r
         JOIN states st ON st.id = r.state_id
         WHERE r.status = 'pending'
         ORDER BY r.created_at ASC`,
      )
      .all();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ requests: rows }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load account requests" }));
  }
}

function approveAccountRequest(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    try {
      const { id, username, reviewNotes } = JSON.parse(body || "{}");
      if (!id) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Request id is required" }));
        return;
      }

      const request = db
        .prepare(
          `SELECT id, email, county, state_id, status
           FROM account_creation_requests
           WHERE id = ?
           LIMIT 1`,
        )
        .get(id);

      if (!request || request.status !== "pending") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Pending request not found" }));
        return;
      }

      const normalizedUsername = String(username || request.email)
        .trim()
        .toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedUsername)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Username must be a valid email" }));
        return;
      }

      const existing = db
        .prepare("SELECT id FROM accounts WHERE LOWER(username) = LOWER(?) LIMIT 1")
        .get(normalizedUsername);
      if (existing) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Username already exists" }));
        return;
      }

      const tempPassword = generateTemporaryPassword();
      const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
      const now = Date.now();

      const result = db
        .prepare(
          `INSERT INTO accounts (username, password_hash, county, state_id, approved, must_change_password)
           VALUES (?, ?, ?, ?, 1, 1)`,
        )
        .run(
          normalizedUsername,
          hashedPassword,
          request.county,
          request.state_id,
        );

      db.prepare(
        `UPDATE account_creation_requests
         SET status = 'approved', account_id = ?, review_notes = ?, reviewed_at = ?
         WHERE id = ?`,
      ).run(
        result.lastInsertRowid,
        String(reviewNotes || "").trim() || null,
        now,
        request.id,
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          message: `Approved request for ${normalizedUsername}`,
          account: {
            id: result.lastInsertRowid,
            username: normalizedUsername,
            temporaryPassword: tempPassword,
          },
        }),
      );
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}

function rejectAccountRequest(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", () => {
    try {
      const { id, reviewNotes } = JSON.parse(body || "{}");
      if (!id) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Request id is required" }));
        return;
      }

      const request = db
        .prepare(
          "SELECT id, status FROM account_creation_requests WHERE id = ? LIMIT 1",
        )
        .get(id);
      if (!request || request.status !== "pending") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Pending request not found" }));
        return;
      }

      db.prepare(
        `UPDATE account_creation_requests
         SET status = 'denied', review_notes = ?, reviewed_at = ?
         WHERE id = ?`,
      ).run(String(reviewNotes || "").trim() || null, Date.now(), request.id);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "Account request denied" }));
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}

function approveAccount(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { id } = JSON.parse(body || "{}");
      if (!id) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Account id is required" }));
        return;
      }
      const account = db
        .prepare("SELECT id, username, approved FROM accounts WHERE id = ?")
        .get(id);
      if (!account) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Account not found" }));
        return;
      }
      db.prepare("UPDATE accounts SET approved = 1 WHERE id = ?").run(id);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: `Approved ${account.username}` }));
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}

function rejectAccount(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { id } = JSON.parse(body || "{}");
      if (!id) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Account id is required" }));
        return;
      }
      const account = db
        .prepare(
          "SELECT id, username FROM accounts WHERE id = ? AND approved = 0",
        )
        .get(id);
      if (!account) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Pending account not found" }));
        return;
      }
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ message: `Rejected and removed ${account.username}` }),
      );
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}

async function getSecurityOverview(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  try {
    const snapshot = security.getSecuritySnapshot(200);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(snapshot));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load security state" }));
  }
}

async function clearSecurityState(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  try {
    const body = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
    const ip = String(body.ip || "").trim();

    const cleared = ip
      ? security.clearSecurityForIp(ip)
      : security.clearAllSecurityState();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ cleared, scope: ip ? "ip" : "all", ip: ip || null }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

module.exports = {
  login,
  verifyTwoFactor,
  resendTwoFactor,
  requestAccountAccess,
  createAccount,
  deleteAccount,
  getAccount,
  getSession,
  getCounties,
  getStates,
  updateAccount,
  changePassword,
  requestPasswordReset,
  resetPasswordWithToken,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  getPendingAccountRequests,
  approveAccountRequest,
  rejectAccountRequest,
  getSecurityOverview,
  clearSecurityState,
};
