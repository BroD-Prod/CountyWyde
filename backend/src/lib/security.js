const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("./db");

const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMIT = 120;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const SCORE_BLOCK_THRESHOLD = 10;
const SCORE_WINDOW_MS = 10 * 60 * 1000;

const ROUTE_LIMITS = {
  "GET:/account/session": 600,
  "POST:/account/login": 20,
  "POST:/account/signup": 20,
  "DELETE:/account/delete": 30,
  "PATCH:/account/update": 60,
  "GET:/admin/pending": 30,
  "PATCH:/admin/approve": 30,
  "DELETE:/admin/reject": 30,
  "POST:/search": 60,
  "POST:/upload": 30,
};

let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const LOG_DIR = path.join(__dirname, "../../data");
const REQUEST_LOG_FILE = path.join(LOG_DIR, "request.log");
const SECURITY_LOG_FILE = path.join(LOG_DIR, "security.log");

function nowIso() {
  return new Date().toISOString();
}

async function appendJsonLine(filePath, payload) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch { }
}

function getClientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}

function isLocalDevRequest(req) {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  const ip = getClientIp(req);
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function getPath(req) {
  return String(req.url || "/").split("?")[0] || "/";
}

function getRouteKey(req) {
  return `${req.method}:${getPath(req)}`;
}

function getRouteLimit(req) {
  return ROUTE_LIMITS[getRouteKey(req)] || DEFAULT_LIMIT;
}

function beginRequest(req) {
  return {
    startedAt: Date.now(),
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ip: getClientIp(req),
    path: getPath(req),
  };
}

async function cleanupExpiredSecurityRows() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  await db.prepare("DELETE FROM security_rate_limits WHERE reset_at <= ?").run(now);
  await db.prepare("DELETE FROM security_blocks WHERE blocked_until <= ?").run(now);
  await db.prepare("DELETE FROM security_suspicion WHERE reset_at <= ?").run(now);
}

async function getBlockInfo(ip) {
  await cleanupExpiredSecurityRows();

  const info = await db
    .prepare(
      "SELECT blocked_until AS blockedUntil, reason, created_at AS createdAt FROM security_blocks WHERE ip = ? LIMIT 1",
    )
    .get(ip);

  if (!info) {
    return null;
  }

  if (info.blockedUntil <= Date.now()) {
    await db.prepare("DELETE FROM security_blocks WHERE ip = ?").run(ip);
    return null;
  }

  return info;
}

async function isBlocked(req) {
  if (isLocalDevRequest(req)) {
    return null;
  }
  const ip = getClientIp(req);
  return getBlockInfo(ip);
}

async function blockIp(ip, reason) {
  const blockedUntil = Date.now() + BLOCK_DURATION_MS;
  await db
    .prepare(
      `INSERT INTO security_blocks (ip, blocked_until, reason, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           blocked_until = excluded.blocked_until,
           reason = excluded.reason,
           created_at = excluded.created_at`,
    )
    .run(ip, blockedUntil, reason, Date.now());

  void appendJsonLine(SECURITY_LOG_FILE, {
    ts: nowIso(),
    event: "ip_blocked",
    ip,
    reason,
    blockedUntil: new Date(blockedUntil).toISOString(),
  });
}

async function checkRateLimit(req) {
  if (isLocalDevRequest(req)) {
    return { allowed: true };
  }
  if (req.method === "OPTIONS") {
    return { allowed: true };
  }

  const ip = getClientIp(req);
  const path = getPath(req);
  const key = `${ip}:${req.method}:${path}`;
  const now = Date.now();
  const limit = getRouteLimit(req);

  await cleanupExpiredSecurityRows();

  const row = await db
    .prepare(
      `SELECT count, reset_at AS resetAt
         FROM security_rate_limits
         WHERE ip = ? AND method = ? AND path = ?
         LIMIT 1`,
    )
    .get(ip, req.method, path);

  if (!row || row.resetAt <= now) {
    await db
      .prepare(
        `INSERT INTO security_rate_limits (ip, method, path, count, reset_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(ip, method, path) DO UPDATE SET
               count = excluded.count,
               reset_at = excluded.reset_at,
               updated_at = excluded.updated_at`,
      )
      .run(ip, req.method, path, 1, now + WINDOW_MS, now);
    return { allowed: true };
  }

  const nextCount = row.count + 1;
  await db
    .prepare(
      `UPDATE security_rate_limits
         SET count = ?, updated_at = ?
         WHERE ip = ? AND method = ? AND path = ?`,
    )
    .run(nextCount, now, ip, req.method, path);

  if (nextCount > limit * 2) {
    await blockIp(ip, "excessive_request_rate");
    return {
      allowed: false,
      statusCode: 403,
      error: "Request blocked due to suspicious traffic",
      retryAfterSeconds: Math.ceil(BLOCK_DURATION_MS / 1000),
    };
  }

  if (nextCount > limit) {
    void appendJsonLine(SECURITY_LOG_FILE, {
      ts: nowIso(),
      event: "rate_limit_exceeded",
      ip,
      method: req.method,
      path,
      count: nextCount,
      limit,
      resetAt: new Date(row.resetAt).toISOString(),
    });

    return {
      allowed: false,
      statusCode: 429,
      error: "Too many requests",
      retryAfterSeconds: Math.ceil((row.resetAt - now) / 1000),
    };
  }

  return { allowed: true };
}

async function addSuspicion(req, delta, reason) {
  if (isLocalDevRequest(req)) {
    return;
  }
  if (delta <= 0) {
    return;
  }

  const ip = getClientIp(req);
  const now = Date.now();
  await cleanupExpiredSecurityRows();

  const row = await db
    .prepare(
      "SELECT score, reset_at AS resetAt FROM security_suspicion WHERE ip = ? LIMIT 1",
    )
    .get(ip);

  const currentScore = !row || row.resetAt <= now ? delta : row.score + delta;
  const resetAt =
    !row || row.resetAt <= now ? now + SCORE_WINDOW_MS : row.resetAt;

  await db
    .prepare(
      `INSERT INTO security_suspicion (ip, score, reset_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           score = excluded.score,
           reset_at = excluded.reset_at,
           updated_at = excluded.updated_at`,
    )
    .run(ip, currentScore, resetAt, now);

  void appendJsonLine(SECURITY_LOG_FILE, {
    ts: nowIso(),
    event: "suspicion_score",
    ip,
    reason,
    delta,
    score: currentScore,
    resetAt: new Date(resetAt).toISOString(),
  });

  if (currentScore >= SCORE_BLOCK_THRESHOLD) {
    await blockIp(ip, `suspicion_threshold:${reason}`);
    await db.prepare("DELETE FROM security_suspicion WHERE ip = ?").run(ip);
  }
}

async function inspectResponseForSuspicion(req, statusCode) {
  const path = getPath(req);

  if (statusCode === 404) {
    await addSuspicion(req, 1, "not_found_scanning");
  }

  if (statusCode === 413) {
    await addSuspicion(req, 4, "payload_too_large");
  }

  if (statusCode === 429 && path !== "/account/session") {
    await addSuspicion(req, 3, "rate_limited_repeatedly");
  }

  if (path === "/account/login" && (statusCode === 401 || statusCode === 403)) {
    await addSuspicion(req, 2, "failed_login_attempt");
  }

  if (path.startsWith("/admin/") && statusCode === 403) {
    await addSuspicion(req, 3, "admin_key_failures");
  }
}

async function completeRequest(req, res, context) {
  const statusCode = Number(res.statusCode || 200);
  const durationMs = Date.now() - context.startedAt;

  await inspectResponseForSuspicion(req, statusCode);

  void appendJsonLine(REQUEST_LOG_FILE, {
    ts: nowIso(),
    requestId: context.requestId,
    ip: context.ip,
    method: req.method,
    path: context.path,
    statusCode,
    durationMs,
    userAgent: String(req.headers["user-agent"] || ""),
  });
}

async function getSecuritySnapshot(limit = 100) {
  await cleanupExpiredSecurityRows();

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const now = Date.now();

  const blocked = await db
    .prepare(
      `SELECT ip, reason, blocked_until AS blockedUntil, created_at AS createdAt
         FROM security_blocks
         ORDER BY blocked_until DESC
         LIMIT ?`,
    )
    .all(safeLimit);

  const suspicious = await db
    .prepare(
      `SELECT ip, score, reset_at AS resetAt, updated_at AS updatedAt
         FROM security_suspicion
         ORDER BY score DESC, updated_at DESC
         LIMIT ?`,
    )
    .all(safeLimit);

  const rateLimited = await db
    .prepare(
      `SELECT ip, method, path, count, reset_at AS resetAt, updated_at AS updatedAt
         FROM security_rate_limits
         WHERE reset_at > ?
         ORDER BY count DESC, updated_at DESC
         LIMIT ?`,
    )
    .all(now, safeLimit);

  return { blocked, suspicious, rateLimited };
}

async function clearSecurityForIp(ip) {
  const normalizedIp = String(ip || "").trim();
  if (!normalizedIp) {
    return 0;
  }

  return db.transaction(async (tx) => {
    const a = (await tx.run("DELETE FROM security_blocks WHERE ip = ?", [
      normalizedIp,
    ])).changes;
    const b = (await tx.run("DELETE FROM security_suspicion WHERE ip = ?", [
      normalizedIp,
    ])).changes;
    const c = (await tx.run("DELETE FROM security_rate_limits WHERE ip = ?", [
      normalizedIp,
    ])).changes;
    return a + b + c;
  });
}

async function clearAllSecurityState() {
  return db.transaction(async (tx) => {
    const a = (await tx.run("DELETE FROM security_blocks")).changes;
    const b = (await tx.run("DELETE FROM security_suspicion")).changes;
    const c = (await tx.run("DELETE FROM security_rate_limits")).changes;
    return a + b + c;
  });
}

module.exports = {
  beginRequest,
  isBlocked,
  checkRateLimit,
  completeRequest,
  getSecuritySnapshot,
  clearSecurityForIp,
  clearAllSecurityState,
};
