// Admin CRUD for embed_origins, which scopes an embed widget's searches to
// a single state/county (enforced in searchControllers.js), plus a public
// read-only list of active origins that frontend/middleware.ts fetches to
// build its CSP frame-ancestors policy — this table is the single source
// of truth for both "who can frame the widget" and "what can they search",
// so onboarding/revoking a partner here takes effect for both immediately.
require("dotenv").config();
const crypto = require("crypto");
const db = require("../lib/db");
const helperController = require("./helperController");
const { isCountyFormatValid, isRegisteredState } = require("../lib/countyRegistry");

const UNIQUE_VIOLATION = "23505";

const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

function isAdminRequest(req) {
  if (!ADMIN_KEY) return false;
  const providedKey = req.headers["x-admin-key"] || "";

  if (providedKey.length !== ADMIN_KEY.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(providedKey),
    Buffer.from(ADMIN_KEY),
  );
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "").trim()).origin;
  } catch {
    return null;
  }
}

// Public and unauthenticated on purpose: this is the same information a
// browser can already read straight off the CSP header on any response
// from "/", so gating it behind an admin key would add no confidentiality
// and would just make the frontend's CSP allowlist harder to build.
async function getAllowedEmbedOrigins(req, res) {
  try {
    const rows = await db
      .prepare(
        "SELECT DISTINCT origin FROM embed_origins WHERE revoked = FALSE ORDER BY origin ASC",
      )
      .all();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.end(JSON.stringify({ origins: rows.map((row) => row.origin) }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load allowed embed origins" }));
  }
}

async function getEmbedOrigins(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  try {
    const rows = await db
      .prepare(
        "SELECT id, label, origin, state, county, revoked, created_at FROM embed_origins ORDER BY id ASC",
      )
      .all();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ embedOrigins: rows }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to load embed origins" }));
  }
}

async function createEmbedOrigin(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  let body;
  try {
    body = await helperController.parseJsonBody(req);
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
    return;
  }

  const label = String(body.label || "").trim();
  const origin = normalizeOrigin(body.origin);
  const state = String(body.state || "").trim();
  const county = String(body.county || "").trim();

  if (!label || !origin || !state || !county) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "label, a valid origin URL, state, and county are required",
      }),
    );
    return;
  }

  if (!(await isRegisteredState(state))) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "state is not a recognized state" }));
    return;
  }

  if (!isCountyFormatValid(county)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "county is not a valid county name" }));
    return;
  }

  try {
    const row = await db
      .prepare(
        `INSERT INTO embed_origins (label, origin, state, county, revoked, created_at)
         VALUES (?, ?, ?, ?, FALSE, ?)
         RETURNING id, label, origin, state, county, revoked, created_at`,
      )
      .get(label, origin, state, county, Date.now());

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ embedOrigin: row }));
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "An active embed origin already exists for this origin",
        }),
      );
      return;
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to create embed origin" }));
  }
}

async function revokeEmbedOrigin(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  let body;
  try {
    body = await helperController.parseJsonBody(req);
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
    return;
  }

  const id = body.id;
  if (!id) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Embed origin id is required" }));
    return;
  }

  try {
    const existing = await db
      .prepare("SELECT id, origin FROM embed_origins WHERE id = ?")
      .get(id);

    if (!existing) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Embed origin not found" }));
      return;
    }

    await db
      .prepare("UPDATE embed_origins SET revoked = TRUE WHERE id = ?")
      .run(id);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: `Revoked ${existing.origin}` }));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to revoke embed origin" }));
  }
}

module.exports = {
  getAllowedEmbedOrigins,
  getEmbedOrigins,
  createEmbedOrigin,
  revokeEmbedOrigin,
};
