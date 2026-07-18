const bcrypt = require("bcrypt");
const crypto = require("crypto");
const db = require("../lib/db");
const security = require("../lib/security");
const { sendTwoFactorEmail } = require("../lib/email");
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

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_LIMIT = 10;
const SIGNUP_RATE_LIMIT = 10;
const DELETE_RATE_LIMIT = 10;
const UPDATE_RATE_LIMIT = 30;
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
         WHERE email = ?
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
      .prepare("SELECT id FROM accounts WHERE username = ? LIMIT 1")
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
    const selectedCounty = normalizeCounty(county);
    const selectedState = resolveState(state);

    if (!username || !password || !selectedCounty || !state) {
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
      .prepare("SELECT 1 FROM accounts WHERE username = ?")
      .get(username);
    if (existing) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Username already exists" }));
      return;
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    db.prepare(
      "INSERT INTO accounts (username, password_hash, county, state_id, approved) VALUES (?, ?, ?, ?, 0)",
    ).run(username, hashedPassword, selectedCounty, selectedState.id);

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
    res.end(JSON.stringify({ message: `Login successful for ${challenge.username}` }));
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
        .prepare("SELECT id FROM accounts WHERE username = ? LIMIT 1")
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
          `INSERT INTO accounts (username, password_hash, county, state_id, approved)
           VALUES (?, ?, ?, ?, 1)`,
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
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  getPendingAccountRequests,
  approveAccountRequest,
  rejectAccountRequest,
  getSecurityOverview,
  clearSecurityState,
};
