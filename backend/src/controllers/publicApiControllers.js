// County push API (/api/v1/documents), authenticated with a county API key
// created on the account page. Meant for counties with developers: their CMS
// or a script calls this whenever a document is published, updated or removed.
//
// A key is only honoured while the account that created it still exists, is
// approved, and still belongs to the key's county — so a key can only ever
// write to its own county, and stops working if its owner moves counties.
const db = require("../lib/db");
const helperController = require("./helperController");
const { hashApiKey } = require("./integrationsControllers");
const { safeFetch } = require("../lib/safeFetch");
const { filenameFromResponse } = require("../lib/sourceCrawler");
const {
  MAX_FILE_BYTES,
  ingestDocument,
  removeSource,
  resolveMimeType,
} = require("../lib/ingest");

const MAX_JSON_BYTES = 15 * 1024 * 1024; // 10 MB file + base64 overhead

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readApiKey(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];
  return String(req.headers["x-api-key"] || "").trim() || null;
}

async function authenticateApiKey(req, res) {
  const key = readApiKey(req);
  if (!key) {
    send(res, 401, {
      error: "Missing API key. Send it as: Authorization: Bearer <your key>",
    });
    return null;
  }

  const row = await db
    .prepare(
      `SELECT k.id, k.county, k.state
         FROM county_api_keys k
         JOIN accounts a ON a.id = k.account_id
         JOIN states st ON st.id = a.state_id
        WHERE k.key_hash = ?
          AND k.revoked = FALSE
          AND a.approved = TRUE
          AND LOWER(TRIM(a.county)) = LOWER(k.county)
          AND UPPER(st.abbreviation) = UPPER(k.state)`,
    )
    .get(hashApiKey(key));

  if (!row) {
    send(res, 401, { error: "Invalid or revoked API key" });
    return null;
  }

  await db
    .prepare("UPDATE county_api_keys SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), row.id);

  return { keyId: String(row.id), county: row.county, state: row.state };
}

function cleanName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 150);
}

// POST /api/v1/documents
//   { "name": "agenda-2026-11-04.pdf", "type": "application/pdf", "base64": "..." }
//   or { "url": "https://county.gov/files/agenda.pdf", "name": "optional override" }
// Re-sending a document with the same name replaces the previous version.
async function pushDocument(req, res) {
  const auth = await authenticateApiKey(req, res);
  if (!auth) return;

  let body;
  try {
    body = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
  } catch (error) {
    send(res, error.message === "Payload too large" ? 413 : 400, {
      error: error.message || "Invalid JSON body",
    });
    return;
  }

  let buffer;
  let name = cleanName(body.name);
  let mimeType;
  let sourceUrl = null;

  if (body.url) {
    let response;
    try {
      response = await safeFetch(body.url, { maxBytes: MAX_FILE_BYTES });
    } catch (error) {
      const status = error.code === "FILE_TOO_LARGE" ? 413 : 422;
      send(res, status, { error: `Could not fetch url: ${error.message}` });
      return;
    }
    if (response.status >= 400) {
      send(res, 422, { error: `Could not fetch url: HTTP ${response.status}` });
      return;
    }
    const contentType = String(response.headers["content-type"] || "");
    const guessedName = filenameFromResponse(response.headers, response.url, null);
    mimeType = resolveMimeType(body.type || contentType, name || guessedName);
    name = name || filenameFromResponse(response.headers, response.url, mimeType);
    buffer = response.body;
    sourceUrl = String(body.url);
  } else if (body.base64) {
    if (!name) {
      send(res, 422, { error: "name is required when sending base64 content" });
      return;
    }
    const raw = String(body.base64);
    buffer = Buffer.from(raw.includes(",") ? raw.split(",")[1] : raw, "base64");
    if (!buffer.length) {
      send(res, 422, { error: "base64 content is empty or invalid" });
      return;
    }
    if (buffer.length > MAX_FILE_BYTES) {
      send(res, 413, { error: "File is larger than the 10 MB limit" });
      return;
    }
    mimeType = resolveMimeType(body.type, name);
    sourceUrl = body.sourceUrl ? String(body.sourceUrl).slice(0, 2000) : null;
  } else {
    send(res, 422, {
      error: "Send either { name, type, base64 } or { url } in the request body",
    });
    return;
  }

  if (!mimeType) {
    send(res, 415, {
      error: "Unsupported document type. Supported: PDF, DOCX, CSV, TXT, JSON",
    });
    return;
  }

  try {
    const result = await ingestDocument({
      buffer,
      name,
      mimeType,
      county: auth.county,
      state: auth.state,
      sourceName: name,
      sourceUrl,
      replace: true,
    });
    send(res, result.replaced ? 200 : 201, {
      name: result.source,
      chunks: result.added,
      replaced: result.replaced,
    });
  } catch (error) {
    const status = error.code === "FILE_TOO_LARGE" ? 413 : 422;
    send(res, status, { error: error.message || "Could not process document" });
  }
}

// GET /api/v1/documents
async function listDocuments(req, res) {
  const auth = await authenticateApiKey(req, res);
  if (!auth) return;

  const rows = await db
    .prepare(
      `SELECT source, MIN(parsed_type) AS parsed_type, COUNT(*) AS chunks, MIN(created_at) AS created_at
         FROM upload_chunks
        WHERE LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?)
        GROUP BY source
        ORDER BY MIN(created_at) DESC`,
    )
    .all(auth.county, auth.state);

  send(res, 200, {
    county: auth.county,
    state: auth.state,
    total: rows.length,
    documents: rows.map((row) => ({
      name: row.source,
      type: row.parsed_type,
      chunks: Number(row.chunks),
      createdAt: row.created_at,
    })),
  });
}

// DELETE /api/v1/documents?name=agenda-2026-11-04.pdf
async function deleteDocument(req, res) {
  const auth = await authenticateApiKey(req, res);
  if (!auth) return;

  const requestUrl = new URL(req.url, "http://localhost");
  let name = cleanName(requestUrl.searchParams.get("name"));
  if (!name) {
    try {
      name = cleanName((await helperController.parseJsonBody(req)).name);
    } catch {
      name = "";
    }
  }
  if (!name) {
    send(res, 422, { error: "Pass the document name, e.g. ?name=agenda.pdf" });
    return;
  }

  const deleted = await removeSource(name, auth.county, auth.state);
  if (deleted === 0) {
    send(res, 404, { error: "No document with that name in your county" });
    return;
  }
  send(res, 200, { name, deleted: true });
}

module.exports = {
  authenticateApiKey,
  pushDocument,
  listDocuments,
  deleteDocument,
};
