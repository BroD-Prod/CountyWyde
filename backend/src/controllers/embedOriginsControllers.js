require("dotenv").config();
const crypto = require("crypto");
const db = require("../lib/db");
const helperController = require("./helperController");

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

  try {
    const body = await helperController.parseJsonBody(req);
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
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

async function revokeEmbedOrigin(req, res) {
  if (!isAdminRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  try {
    const body = await helperController.parseJsonBody(req);
    const id = body.id;

    if (!id) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Embed origin id is required" }));
      return;
    }

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
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message || "Invalid JSON body" }));
  }
}

module.exports = {
  getEmbedOrigins,
  createEmbedOrigin,
  revokeEmbedOrigin,
};
