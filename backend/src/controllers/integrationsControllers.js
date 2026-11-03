// Account-page management for document integrations: API keys (push) and
// monitored website sources (pull). Every route requires a signed-in,
// approved county account, and everything is scoped to that account's
// county + state — a user can never see or touch another county's keys or
// sources. The public, key-authenticated API lives in publicApiControllers.js.
const crypto = require("node:crypto");
const db = require("../lib/db");
const helperController = require("./helperController");
const { normalizeCounty } = require("../lib/countyRegistry");
const { parsePublicUrl } = require("../lib/safeFetch");
const { claimSourceNow, runSourceCheck } = require("../lib/sourceCrawler");

const API_KEY_PREFIX = "cw_live_";
const MAX_ACTIVE_KEYS_PER_COUNTY = 10;
const MAX_SOURCES_PER_COUNTY = 25;
const ALLOWED_INTERVAL_HOURS = new Set([6, 24, 168]);
const UNIQUE_VIOLATION = "23505";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function toNumber(value) {
  return value == null ? null : Number(value);
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function generateApiKey() {
  const key = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: hashApiKey(key) };
}

/**
 * Resolve the signed-in county account, or answer 401/403/400 and return null.
 */
async function requireCountyUser(req, res) {
  const user = await helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!user) {
    send(res, 401, { error: "You must be signed in to manage integrations" });
    return null;
  }

  const account = await db
    .prepare("SELECT approved FROM accounts WHERE id = ?")
    .get(user.id);
  if (!account?.approved) {
    send(res, 403, { error: "Your account must be approved to use integrations" });
    return null;
  }

  const county = normalizeCounty(user.county);
  const state = String(user.state_abbreviation || "").trim();
  if (!county || !state) {
    send(res, 400, { error: "No county/state found on your account" });
    return null;
  }

  return { id: user.id, username: user.username, county, state };
}

async function readBody(req, res) {
  try {
    return await helperController.parseJsonBody(req);
  } catch (error) {
    send(res, error.message === "Payload too large" ? 413 : 400, {
      error: error.message || "Invalid JSON body",
    });
    return null;
  }
}

function serializeKey(row) {
  return {
    id: String(row.id),
    label: row.label,
    keyPrefix: row.key_prefix,
    createdBy: row.created_by || null,
    createdAt: toNumber(row.created_at),
    lastUsedAt: toNumber(row.last_used_at),
  };
}

function serializeSource(row) {
  return {
    id: String(row.id),
    label: row.label,
    url: row.url,
    checkIntervalHours: Number(row.check_interval_hours),
    active: Boolean(row.active),
    lastCheckedAt: toNumber(row.last_checked_at),
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,
    lastNewCount: Number(row.last_new_count || 0),
    documentCount: Number(row.document_count || 0),
    createdBy: row.created_by || null,
    createdAt: toNumber(row.created_at),
  };
}

async function listKeys(user) {
  const rows = await db
    .prepare(
      `SELECT k.id, k.label, k.key_prefix, k.created_at, k.last_used_at, a.username AS created_by
         FROM county_api_keys k
         LEFT JOIN accounts a ON a.id = k.account_id
        WHERE LOWER(k.county) = LOWER(?) AND LOWER(k.state) = LOWER(?) AND k.revoked = FALSE
        ORDER BY k.created_at DESC`,
    )
    .all(user.county, user.state);
  return rows.map(serializeKey);
}

async function getSourceRow(user, id) {
  return db
    .prepare(
      `SELECT s.*, a.username AS created_by,
              (SELECT COUNT(*) FROM source_documents d
                WHERE d.source_id = s.id AND d.content_hash IS NOT NULL) AS document_count
         FROM document_sources s
         LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.id = ? AND LOWER(s.county) = LOWER(?) AND LOWER(s.state) = LOWER(?)`,
    )
    .get(id, user.county, user.state);
}

async function listSources(user) {
  const rows = await db
    .prepare(
      `SELECT s.*, a.username AS created_by,
              (SELECT COUNT(*) FROM source_documents d
                WHERE d.source_id = s.id AND d.content_hash IS NOT NULL) AS document_count
         FROM document_sources s
         LEFT JOIN accounts a ON a.id = s.account_id
        WHERE LOWER(s.county) = LOWER(?) AND LOWER(s.state) = LOWER(?)
        ORDER BY s.created_at DESC`,
    )
    .all(user.county, user.state);
  return rows.map(serializeSource);
}

function parseId(value) {
  const id = String(value || "").trim();
  return /^\d{1,18}$/.test(id) ? id : null;
}

function startCheckInBackground(source) {
  runSourceCheck(source).catch((error) => {
    console.error("[documentMonitor] on-demand check failed:", error?.message);
  });
}

// GET /account/integrations
async function getIntegrations(req, res) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  send(res, 200, {
    county: user.county,
    state: user.state,
    apiKeys: await listKeys(user),
    sources: await listSources(user),
  });
}

// POST /account/integrations/api-keys  { label }
async function createApiKey(req, res) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const body = await readBody(req, res);
  if (!body) return;

  const label = String(body.label || "").trim().slice(0, 80);
  if (!label) {
    send(res, 400, { error: "Give the key a name, e.g. \"County website CMS\"" });
    return;
  }

  const active = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM county_api_keys WHERE LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?) AND revoked = FALSE",
    )
    .get(user.county, user.state);
  if (Number(active?.count || 0) >= MAX_ACTIVE_KEYS_PER_COUNTY) {
    send(res, 409, {
      error: `Your county already has ${MAX_ACTIVE_KEYS_PER_COUNTY} active keys. Revoke one first.`,
    });
    return;
  }

  const { key, prefix, hash } = generateApiKey();
  const row = await db
    .prepare(
      `INSERT INTO county_api_keys (account_id, county, state, label, key_prefix, key_hash, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, FALSE, ?)
       RETURNING id, label, key_prefix, created_at, last_used_at`,
    )
    .get(user.id, user.county, user.state, label, prefix, hash, Date.now());

  // The full key is returned exactly once; only its hash is stored.
  send(res, 201, { apiKey: serializeKey({ ...row, created_by: user.username }), key });
}

// DELETE /account/integrations/api-keys/:id
async function revokeApiKey(req, res, rawId) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const id = parseId(rawId);
  if (!id) {
    send(res, 400, { error: "Invalid key id" });
    return;
  }

  const result = await db
    .prepare(
      `UPDATE county_api_keys SET revoked = TRUE
        WHERE id = ? AND LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?) AND revoked = FALSE`,
    )
    .run(id, user.county, user.state);
  if (result.changes === 0) {
    send(res, 404, { error: "API key not found" });
    return;
  }
  send(res, 200, { revoked: true });
}

// POST /account/integrations/sources  { label, url, checkIntervalHours }
async function createSource(req, res) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const body = await readBody(req, res);
  if (!body) return;

  let url;
  try {
    url = parsePublicUrl(body.url).toString();
  } catch (error) {
    send(res, 400, { error: error.message || "Enter a valid website address" });
    return;
  }

  const label = String(body.label || "").trim().slice(0, 80) || new URL(url).hostname;
  const interval = Number(body.checkIntervalHours || 24);
  if (!ALLOWED_INTERVAL_HOURS.has(interval)) {
    send(res, 400, { error: "Check frequency must be every 6 hours, daily, or weekly" });
    return;
  }

  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM document_sources WHERE LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?)",
    )
    .get(user.county, user.state);
  if (Number(existing?.count || 0) >= MAX_SOURCES_PER_COUNTY) {
    send(res, 409, {
      error: `Your county can monitor up to ${MAX_SOURCES_PER_COUNTY} pages. Remove one first.`,
    });
    return;
  }

  let row;
  try {
    row = await db
      .prepare(
        `INSERT INTO document_sources (account_id, county, state, label, url, check_interval_hours, active, last_status, last_checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, 'checking', ?, ?)
         RETURNING *`,
      )
      .get(user.id, user.county, user.state, label, url, interval, Date.now(), Date.now());
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      send(res, 409, { error: "Your county is already monitoring this page" });
      return;
    }
    throw error;
  }

  // Run the first check right away so the user sees results (or a problem
  // with the URL) without waiting for the schedule.
  startCheckInBackground(row);

  send(res, 201, { source: serializeSource({ ...row, created_by: user.username }) });
}

// PATCH /account/integrations/sources/:id  { label?, active?, checkIntervalHours? }
async function updateSource(req, res, rawId) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const id = parseId(rawId);
  if (!id) {
    send(res, 400, { error: "Invalid source id" });
    return;
  }
  const body = await readBody(req, res);
  if (!body) return;

  const current = await getSourceRow(user, id);
  if (!current) {
    send(res, 404, { error: "Monitored page not found" });
    return;
  }

  const label = body.label !== undefined
    ? String(body.label || "").trim().slice(0, 80) || current.label
    : current.label;
  const active = body.active !== undefined ? Boolean(body.active) : Boolean(current.active);
  const interval = body.checkIntervalHours !== undefined
    ? Number(body.checkIntervalHours)
    : Number(current.check_interval_hours);
  if (!ALLOWED_INTERVAL_HOURS.has(interval)) {
    send(res, 400, { error: "Check frequency must be every 6 hours, daily, or weekly" });
    return;
  }

  await db
    .prepare(
      "UPDATE document_sources SET label = ?, active = ?, check_interval_hours = ? WHERE id = ?",
    )
    .run(label, active, interval, id);

  send(res, 200, { source: serializeSource(await getSourceRow(user, id)) });
}

// DELETE /account/integrations/sources/:id
// Stops monitoring. Documents already indexed stay searchable; they can be
// removed individually from the upload page like any other document.
async function deleteSource(req, res, rawId) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const id = parseId(rawId);
  if (!id) {
    send(res, 400, { error: "Invalid source id" });
    return;
  }

  const result = await db
    .prepare(
      "DELETE FROM document_sources WHERE id = ? AND LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?)",
    )
    .run(id, user.county, user.state);
  if (result.changes === 0) {
    send(res, 404, { error: "Monitored page not found" });
    return;
  }
  send(res, 200, { deleted: true });
}

// POST /account/integrations/sources/:id/check
async function checkSourceNow(req, res, rawId) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const id = parseId(rawId);
  if (!id) {
    send(res, 400, { error: "Invalid source id" });
    return;
  }

  const claimed = await claimSourceNow(id, user.county, user.state);
  if (!claimed) {
    const exists = await getSourceRow(user, id);
    send(res, exists ? 409 : 404, {
      error: exists ? "This page is already being checked" : "Monitored page not found",
    });
    return;
  }

  startCheckInBackground(claimed);
  send(res, 202, { source: serializeSource(await getSourceRow(user, id)) });
}

// GET /account/integrations/sources/:id/documents
async function getSourceDocuments(req, res, rawId) {
  const user = await requireCountyUser(req, res);
  if (!user) return;
  const id = parseId(rawId);
  if (!id) {
    send(res, 400, { error: "Invalid source id" });
    return;
  }
  if (!(await getSourceRow(user, id))) {
    send(res, 404, { error: "Monitored page not found" });
    return;
  }

  const rows = await db
    .prepare(
      `SELECT url, source_name, content_hash, last_error, first_seen_at, last_checked_at, last_ingested_at
         FROM source_documents WHERE source_id = ?
        ORDER BY COALESCE(last_ingested_at, first_seen_at) DESC
        LIMIT 200`,
    )
    .all(id);

  send(res, 200, {
    documents: rows.map((row) => ({
      url: row.url,
      name: row.source_name || null,
      indexed: Boolean(row.content_hash),
      error: row.last_error || null,
      firstSeenAt: toNumber(row.first_seen_at),
      lastCheckedAt: toNumber(row.last_checked_at),
      lastIngestedAt: toNumber(row.last_ingested_at),
    })),
  });
}

module.exports = {
  hashApiKey,
  generateApiKey,
  getIntegrations,
  createApiKey,
  revokeApiKey,
  createSource,
  updateSource,
  deleteSource,
  checkSourceNow,
  getSourceDocuments,
};
