const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("./db");

const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMIT = 120;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const SCORE_BLOCK_THRESHOLD = 10;
const SCORE_WINDOW_MS = 10 * 60 * 1000;

const ROUTE_LIMITS = {
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

db.exec(`
    CREATE TABLE IF NOT EXISTS security_rate_limits (
        ip TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ip, method, path)
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS security_blocks (
        ip TEXT PRIMARY KEY,
        blocked_until INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS security_suspicion (
        ip TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_security_rate_limits_reset_at ON security_rate_limits(reset_at);",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_security_blocks_blocked_until ON security_blocks(blocked_until);",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_security_suspicion_reset_at ON security_suspicion(reset_at);",
);

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
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function isLocalhostIp(ip) {
  const normalizedIp = String(ip || "").trim().toLowerCase();
  return (
    normalizedIp === "localhost" ||
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "::ffff:127.0.0.1" ||
    normalizedIp === "0:0:0:0:0:0:0:1"
  );
}

function isDevelopmentLocalRequest(req, ip) {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  const candidateIp = ip || getClientIp(req);
  return isLocalhostIp(candidateIp);
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

function cleanupExpiredSecurityRows() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  db.prepare("DELETE FROM security_rate_limits WHERE reset_at <= ?").run(now);
  db.prepare("DELETE FROM security_blocks WHERE blocked_until <= ?").run(now);
  db.prepare("DELETE FROM security_suspicion WHERE reset_at <= ?").run(now);
}

function getBlockInfo(ip) {
  cleanupExpiredSecurityRows();

  const info = db
    .prepare(
      "SELECT blocked_until AS blockedUntil, reason, created_at AS createdAt FROM security_blocks WHERE ip = ? LIMIT 1",
    )
    .get(ip);

  if (!info) {
    return null;
  }

  if (info.blockedUntil <= Date.now()) {
    db.prepare("DELETE FROM security_blocks WHERE ip = ?").run(ip);
    return null;
  }

  return info;
}

function isBlocked(req) {
  const ip = getClientIp(req);
  if (isDevelopmentLocalRequest(req, ip)) {
    return null;
  }

  return getBlockInfo(ip);
}

function blockIp(ip, reason) {
  if (process.env.NODE_ENV !== "production" && isLocalhostIp(ip)) {
    return;
  }

  const blockedUntil = Date.now() + BLOCK_DURATION_MS;
  db.prepare(
    `INSERT INTO security_blocks (ip, blocked_until, reason, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           blocked_until = excluded.blocked_until,
           reason = excluded.reason,
           created_at = excluded.created_at`,
  ).run(ip, blockedUntil, reason, Date.now());

  void appendJsonLine(SECURITY_LOG_FILE, {
    ts: nowIso(),
    event: "ip_blocked",
    ip,
    reason,
    blockedUntil: new Date(blockedUntil).toISOString(),
  });
}

function checkRateLimit(req) {
  if (req.method === "OPTIONS") {
    return { allowed: true };
  }

  const ip = getClientIp(req);
  const path = getPath(req);
  const key = `${ip}:${req.method}:${path}`;
  const now = Date.now();
  const limit = getRouteLimit(req);

  cleanupExpiredSecurityRows();

  const row = db
    .prepare(
      `SELECT count, reset_at AS resetAt
         FROM security_rate_limits
         WHERE ip = ? AND method = ? AND path = ?
         LIMIT 1`,
    )
    .get(ip, req.method, path);

  if (!row || row.resetAt <= now) {
    db.prepare(
      `INSERT INTO security_rate_limits (ip, method, path, count, reset_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(ip, method, path) DO UPDATE SET
               count = excluded.count,
               reset_at = excluded.reset_at,
               updated_at = excluded.updated_at`,
    ).run(ip, req.method, path, 1, now + WINDOW_MS, now);
    return { allowed: true };
  }

  const nextCount = row.count + 1;
  db.prepare(
    `UPDATE security_rate_limits
         SET count = ?, updated_at = ?
         WHERE ip = ? AND method = ? AND path = ?`,
  ).run(nextCount, now, ip, req.method, path);

  if (nextCount > limit * 2) {
    blockIp(ip, "excessive_request_rate");
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

function addSuspicion(req, delta, reason) {
  if (delta <= 0) {
    return;
  }

  const ip = getClientIp(req);
  if (isDevelopmentLocalRequest(req, ip)) {
    return;
  }

  const now = Date.now();
  cleanupExpiredSecurityRows();

  const row = db
    .prepare(
      "SELECT score, reset_at AS resetAt FROM security_suspicion WHERE ip = ? LIMIT 1",
    )
    .get(ip);

  const currentScore = !row || row.resetAt <= now ? delta : row.score + delta;
  const resetAt =
    !row || row.resetAt <= now ? now + SCORE_WINDOW_MS : row.resetAt;

  db.prepare(
    `INSERT INTO security_suspicion (ip, score, reset_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           score = excluded.score,
           reset_at = excluded.reset_at,
           updated_at = excluded.updated_at`,
  ).run(ip, currentScore, resetAt, now);

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
    blockIp(ip, `suspicion_threshold:${reason}`);
    db.prepare("DELETE FROM security_suspicion WHERE ip = ?").run(ip);
  }
}

function inspectResponseForSuspicion(req, statusCode) {
  const path = getPath(req);

  if (statusCode === 404) {
    addSuspicion(req, 1, "not_found_scanning");
  }

  if (statusCode === 413) {
    addSuspicion(req, 4, "payload_too_large");
  }

  if (statusCode === 429) {
    addSuspicion(req, 3, "rate_limited_repeatedly");
  }

  if (path === "/account/login" && (statusCode === 401 || statusCode === 403)) {
    addSuspicion(req, 2, "failed_login_attempt");
  }

  if (path.startsWith("/admin/") && statusCode === 403) {
    addSuspicion(req, 3, "admin_key_failures");
  }
}

function completeRequest(req, res, context) {
  const statusCode = Number(res.statusCode || 200);
  const durationMs = Date.now() - context.startedAt;

  inspectResponseForSuspicion(req, statusCode);

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

function getSecuritySnapshot(limit = 100) {
  cleanupExpiredSecurityRows();

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const now = Date.now();

  const blocked = db
    .prepare(
      `SELECT ip, reason, blocked_until AS blockedUntil, created_at AS createdAt
         FROM security_blocks
         ORDER BY blocked_until DESC
         LIMIT ?`,
    )
    .all(safeLimit);

  const suspicious = db
    .prepare(
      `SELECT ip, score, reset_at AS resetAt, updated_at AS updatedAt
         FROM security_suspicion
         ORDER BY score DESC, updated_at DESC
         LIMIT ?`,
    )
    .all(safeLimit);

  const rateLimited = db
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

function clearSecurityForIp(ip) {
  const normalizedIp = String(ip || "").trim();
  if (!normalizedIp) {
    return 0;
  }

  const tx = db.transaction(() => {
    const a = db
      .prepare("DELETE FROM security_blocks WHERE ip = ?")
      .run(normalizedIp).changes;
    const b = db
      .prepare("DELETE FROM security_suspicion WHERE ip = ?")
      .run(normalizedIp).changes;
    const c = db
      .prepare("DELETE FROM security_rate_limits WHERE ip = ?")
      .run(normalizedIp).changes;
    return a + b + c;
  });

  return tx();
}

function clearAllSecurityState() {
  const tx = db.transaction(() => {
    const a = db.prepare("DELETE FROM security_blocks").run().changes;
    const b = db.prepare("DELETE FROM security_suspicion").run().changes;
    const c = db.prepare("DELETE FROM security_rate_limits").run().changes;
    return a + b + c;
  });

  return tx();
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
