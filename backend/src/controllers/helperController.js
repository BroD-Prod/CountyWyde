const crypto = require("crypto");
const db = require("../lib/db");

const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;

  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    out[key] = value;
  }

  return out;
}

function parseJsonBody(req, maxBytes = DEFAULT_MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }

      body += chunk.toString();
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        tooLarge = true;
        reject(new Error("Payload too large"));
      }
    });

    req.on("end", () => {
      if (tooLarge) {
        return;
      }

      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function getAuthenticatedUser(req, options = {}) {
  const { includeState = false, cleanupExpired = true } = options;

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session_token;

  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const now = Date.now();

  if (cleanupExpired) {
    db.prepare(
      "DELETE FROM sessions WHERE CAST(expires_at AS INTEGER) <= ?",
    ).run(now);
  }

  if (includeState) {
    return (
      db
        .prepare(
          `SELECT a.id, a.username, a.county, a.must_change_password,
                  st.name AS state_name, st.abbreviation AS state_abbreviation
             FROM sessions s
             JOIN accounts a ON a.id = s.user_id
             JOIN states st ON st.id = a.state_id
             WHERE s.token = ? AND CAST(s.expires_at AS INTEGER) > ?`,
        )
        .get(tokenHash, now) || null
    );
  }

  return (
    db
      .prepare(
        "SELECT a.id, a.username, a.county, a.must_change_password FROM sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token = ? AND CAST(s.expires_at AS INTEGER) > ?",
      )
      .get(tokenHash, now) || null
  );
}

module.exports = {
  parseCookies,
  parseJsonBody,
  hashToken,
  getAuthenticatedUser,
};
