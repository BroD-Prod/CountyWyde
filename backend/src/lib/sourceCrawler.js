// Website monitor: periodically checks each county's registered document
// sources (an "Agendas & Minutes" page, an RSS feed, a sitemap, or a direct
// file link), ingests documents it hasn't seen, and re-indexes ones whose
// content changed. This is the no-code path for counties without developers;
// counties with developers can push through /api/v1/documents instead.
//
// Only links found directly on the registered page/feed are followed (one
// level, no recursive crawling). They may point at any public host, since
// many counties host files on a third-party CMS/CDN.
const crypto = require("node:crypto");
const path = require("node:path");
const db = require("./db");
const { safeFetch } = require("./safeFetch");
const { ingestDocument, resolveMimeType, mimeFromName } = require("./ingest");

const SCHEDULER_TICK_MS = 5 * 60 * 1000;
const SCHEDULER_FIRST_TICK_MS = 30 * 1000;
const SOURCES_PER_TICK = 5;
const MAX_LINKS_PER_SOURCE = 500;
const MAX_NEW_PER_RUN = 25; // large back-catalogs are ingested over several runs
const MAX_RECHECK_PER_RUN = 25;
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_CHECK_MS = 60 * 60 * 1000;
const SKIPPED_PREFIX = "skipped: ";

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".csv", ".txt", ".json"]);
// Common county CMS download URLs that carry no file extension
// (CivicPlus DocumentCenter/AgendaCenter/Archive Center, Granicus, etc.).
// Their real type is decided from the response's Content-Type.
const DOCUMENT_PATH_PATTERNS = [
  /\/DocumentCenter\/View\//i,
  /\/AgendaCenter\/ViewFile\//i,
  /\/Archive\.aspx\?ADID=/i,
  /\/ArchiveCenter\/ViewFile\//i,
  /\/MetaViewer\.php/i,
  /\/DocumentView\.aspx/i,
  /\/Download(s)?\//i,
];

const runningSources = new Set();

function now() {
  return Date.now();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripCdata(value) {
  return String(value).replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

function isDocumentLink(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const ext = path.extname(decodeURIComponent(url.pathname)).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(ext)) return true;
    const target = `${url.pathname}${url.search}`;
    return DOCUMENT_PATH_PATTERNS.some((pattern) => pattern.test(target));
  } catch {
    return false;
  }
}

function looksLikeXmlFeed(contentType, text) {
  if (/xml|rss|atom/i.test(contentType)) return true;
  return /^\s*(<\?xml|<rss|<feed|<urlset|<sitemapindex)/i.test(text.slice(0, 500));
}

function resolveHref(raw, baseUrl) {
  try {
    const url = new URL(decodeEntities(stripCdata(raw)), baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pull candidate document URLs out of an HTML page or an RSS/Atom/sitemap feed.
 * Exported for tests.
 */
function extractDocumentLinks(body, contentType, baseUrl) {
  const text = body.toString("utf8");
  const found = [];

  if (looksLikeXmlFeed(contentType || "", text)) {
    // RSS/Atom enclosures are explicit attachments: keep them regardless of URL shape.
    for (const match of text.matchAll(/<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["']/gi)) {
      const href = resolveHref(match[1], baseUrl);
      if (href) found.push({ href, explicit: true });
    }
    const patterns = [
      /<loc>([\s\S]*?)<\/loc>/gi, // sitemap
      /<link>([\s\S]*?)<\/link>/gi, // RSS
      /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, // Atom
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const href = resolveHref(match[1], baseUrl);
        if (href) found.push({ href, explicit: false });
      }
    }
  } else {
    const baseMatch = text.match(/<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
    const effectiveBase = (baseMatch && resolveHref(baseMatch[1], baseUrl)) || baseUrl;
    for (const match of text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const href = resolveHref(match[1] ?? match[2] ?? match[3], effectiveBase);
      if (href) found.push({ href, explicit: false });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const { href, explicit } of found) {
    if (seen.has(href)) continue;
    if (!explicit && !isDocumentLink(href)) continue;
    seen.add(href);
    unique.push(href);
    if (unique.length >= MAX_LINKS_PER_SOURCE) break;
  }
  return unique;
}

function filenameFromResponse(headers, url, mimeType) {
  let name = "";
  const disposition = String(headers?.["content-disposition"] || "");
  const extended = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  try {
    if (extended) name = decodeURIComponent(extended[1].trim());
    else if (plain) name = plain[1].trim();
  } catch {
    name = "";
  }

  if (!name) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      name = decodeURIComponent(segments[segments.length - 1] || "");
    } catch {
      name = "";
    }
  }
  if (!name) {
    name = new URL(url).hostname;
  }

  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 150);

  // Give extension-less CMS downloads a readable extension matching their type.
  if (!mimeFromName(name) && mimeType) {
    const ext = Object.entries({
      "application/pdf": ".pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "text/csv": ".csv",
      "application/csv": ".csv",
      "text/plain": ".txt",
      "application/json": ".json",
    }).find(([type]) => type === mimeType)?.[1];
    if (ext) name = `${name}${ext}`;
  }
  return name;
}

// Monitored files share the county's document namespace with manual uploads,
// and re-indexing replaces by source name. Make sure a monitored file never
// claims a name that already belongs to something else in the county.
async function assignSourceName(source, docUrl, filename) {
  const nameTaken = async (candidate) => {
    const inUploads = await db
      .prepare(
        "SELECT 1 FROM upload_chunks WHERE LOWER(source) = LOWER(?) AND LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?) LIMIT 1",
      )
      .get(candidate, source.county, source.state);
    if (inUploads) return true;
    const inSources = await db
      .prepare(
        `SELECT 1 FROM source_documents sd
           JOIN document_sources ds ON ds.id = sd.source_id
          WHERE LOWER(sd.source_name) = LOWER(?)
            AND LOWER(ds.county) = LOWER(?) AND LOWER(ds.state) = LOWER(?)
            AND NOT (sd.source_id = ? AND sd.url = ?)
          LIMIT 1`,
      )
      .get(candidate, source.county, source.state, source.id, docUrl);
    return Boolean(inSources);
  };

  if (!(await nameTaken(filename))) return filename;
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  const suffix = sha256(Buffer.from(docUrl)).slice(0, 6);
  return `${base} (${suffix})${ext}`;
}

async function upsertDocumentRow(sourceId, url, fields) {
  const t = now();
  await db
    .prepare(
      `INSERT INTO source_documents (
         source_id, url, source_name, content_hash, etag, last_modified,
         last_error, first_seen_at, last_checked_at, last_ingested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, url) DO UPDATE SET
         source_name = COALESCE(EXCLUDED.source_name, source_documents.source_name),
         content_hash = COALESCE(EXCLUDED.content_hash, source_documents.content_hash),
         etag = COALESCE(EXCLUDED.etag, source_documents.etag),
         last_modified = COALESCE(EXCLUDED.last_modified, source_documents.last_modified),
         last_error = EXCLUDED.last_error,
         last_checked_at = EXCLUDED.last_checked_at,
         last_ingested_at = COALESCE(EXCLUDED.last_ingested_at, source_documents.last_ingested_at)`,
    )
    .run(
      sourceId,
      url,
      fields.sourceName ?? null,
      fields.contentHash ?? null,
      fields.etag ?? null,
      fields.lastModified ?? null,
      fields.error ?? null,
      t,
      t,
      fields.ingested ? t : null,
    );
}

/**
 * Fetch one discovered document and (re)ingest it if it is new or changed.
 * @returns {Promise<"new"|"updated"|"unchanged"|"skipped"|"error">}
 */
async function processDocument(source, docUrl, existing) {
  const conditional = {};
  if (existing?.content_hash) {
    if (existing.etag) conditional["If-None-Match"] = existing.etag;
    if (existing.last_modified) conditional["If-Modified-Since"] = existing.last_modified;
  }

  let response;
  try {
    response = await safeFetch(docUrl, { headers: conditional });
  } catch (error) {
    const message = error.code === "FILE_TOO_LARGE" || error.code === "UNSAFE_URL"
      ? `${SKIPPED_PREFIX}${error.message}`
      : error.message || "Fetch failed";
    await upsertDocumentRow(source.id, docUrl, { error: message });
    return "error";
  }

  if (response.status === 304) {
    await upsertDocumentRow(source.id, docUrl, {});
    return "unchanged";
  }
  if (response.status >= 400) {
    await upsertDocumentRow(source.id, docUrl, { error: `HTTP ${response.status}` });
    return "error";
  }

  const contentType = String(response.headers["content-type"] || "");
  const provisionalName = filenameFromResponse(response.headers, response.url, null);
  const mimeType = resolveMimeType(contentType, provisionalName);
  if (!mimeType) {
    await upsertDocumentRow(source.id, docUrl, {
      error: `${SKIPPED_PREFIX}not a supported document type (${contentType.split(";")[0] || "unknown"})`,
    });
    return "skipped";
  }

  const contentHash = sha256(response.body);
  const cacheFields = {
    etag: response.headers.etag || null,
    lastModified: response.headers["last-modified"] || null,
  };
  if (existing?.content_hash === contentHash) {
    await upsertDocumentRow(source.id, docUrl, cacheFields);
    return "unchanged";
  }

  const filename = filenameFromResponse(response.headers, response.url, mimeType);
  const sourceName = existing?.source_name || (await assignSourceName(source, docUrl, filename));

  try {
    await ingestDocument({
      buffer: response.body,
      name: sourceName,
      mimeType,
      county: source.county,
      state: source.state,
      sourceName,
      sourceUrl: docUrl,
      replace: Boolean(existing?.content_hash),
    });
  } catch (error) {
    // Unparseable/empty files won't fix themselves; anything else (e.g. the
    // embedding API being down) is retried on a later run.
    const permanent = /no content|Unsupported file type|Invalid JSON|exceeds limit/i.test(error.message || "");
    await upsertDocumentRow(source.id, docUrl, {
      sourceName,
      error: `${permanent ? SKIPPED_PREFIX : ""}${error.message || "Ingest failed"}`,
    });
    return "error";
  }

  await upsertDocumentRow(source.id, docUrl, {
    sourceName,
    contentHash,
    ...cacheFields,
    ingested: true,
  });
  return existing?.content_hash ? "updated" : "new";
}

async function discoverLinks(source) {
  const response = await safeFetch(source.url);
  if (response.status >= 400) {
    throw new Error(`The page returned HTTP ${response.status}`);
  }
  const contentType = String(response.headers["content-type"] || "");
  const name = filenameFromResponse(response.headers, response.url, null);
  if (resolveMimeType(contentType, name) && !/html/i.test(contentType)) {
    return [source.url]; // the source is itself a single document
  }
  return extractDocumentLinks(response.body, contentType, response.url);
}

/** Run one check of a source that the caller has already claimed. */
async function runSourceCheck(source) {
  if (runningSources.has(String(source.id))) return null;
  runningSources.add(String(source.id));

  const summary = { found: 0, new: 0, updated: 0, errors: 0 };
  try {
    const links = await discoverLinks(source);
    summary.found = links.length;

    const knownRows = links.length
      ? await db
        .prepare("SELECT * FROM source_documents WHERE source_id = ? AND url = ANY(?)")
        .all(source.id, links)
      : [];
    const known = new Map(knownRows.map((row) => [row.url, row]));

    const fresh = links.filter((url) => !known.has(url)).slice(0, MAX_NEW_PER_RUN);
    const retryCutoff = now() - RETRY_FAILED_AFTER_MS;
    const recheck = knownRows
      .filter((row) => !String(row.last_error || "").startsWith(SKIPPED_PREFIX))
      .filter((row) => row.content_hash || Number(row.last_checked_at || 0) < retryCutoff)
      .sort((a, b) => Number(a.last_checked_at || 0) - Number(b.last_checked_at || 0))
      .slice(0, MAX_RECHECK_PER_RUN);

    for (const url of fresh) {
      const outcome = await processDocument(source, url, null);
      if (outcome === "new") summary.new += 1;
      if (outcome === "error") summary.errors += 1;
    }
    for (const row of recheck) {
      const outcome = await processDocument(source, row.url, row);
      if (outcome === "new") summary.new += 1;
      if (outcome === "updated") summary.updated += 1;
      if (outcome === "error") summary.errors += 1;
    }

    const noDocsMessage = links.length === 0
      ? "No document links (PDF, Word, CSV, text) were found on this page"
      : null;
    await db
      .prepare(
        `UPDATE document_sources
            SET last_status = ?, last_error = ?, last_new_count = ?, last_checked_at = ?
          WHERE id = ?`,
      )
      .run(noDocsMessage ? "warning" : "ok", noDocsMessage, summary.new + summary.updated, now(), source.id);
  } catch (error) {
    summary.error = error.message || "Check failed";
    await db
      .prepare(
        "UPDATE document_sources SET last_status = 'error', last_error = ?, last_new_count = 0, last_checked_at = ? WHERE id = ?",
      )
      .run(summary.error, now(), source.id);
  } finally {
    runningSources.delete(String(source.id));
  }
  return summary;
}

/** Claim a specific source for an on-demand check. Returns null if busy. */
async function claimSourceNow(sourceId, county, state) {
  const t = now();
  return db
    .prepare(
      `UPDATE document_sources
          SET last_status = 'checking', last_checked_at = ?
        WHERE id = ? AND LOWER(county) = LOWER(?) AND LOWER(state) = LOWER(?)
          AND (last_status IS DISTINCT FROM 'checking' OR last_checked_at < ?)
        RETURNING *`,
    )
    .get(t, sourceId, county, state, t - STALE_CHECK_MS);
}

async function claimDueSources(limit = SOURCES_PER_TICK) {
  const t = now();
  return db
    .prepare(
      `UPDATE document_sources
          SET last_status = 'checking', last_checked_at = ?
        WHERE id IN (
          SELECT id FROM document_sources
           WHERE active = TRUE
             AND (
               -- due by schedule
               (last_status IS DISTINCT FROM 'checking'
                 AND (last_checked_at IS NULL
                      OR last_checked_at + check_interval_hours::BIGINT * 3600000 <= ?))
               -- or a check that was interrupted (e.g. server restart mid-run)
               OR (last_status = 'checking' AND last_checked_at < ?)
             )
           ORDER BY last_checked_at ASC NULLS FIRST
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
    )
    .all(t, t, t - STALE_CHECK_MS, limit);
}

async function runDueSources() {
  const sources = await claimDueSources();
  for (const source of sources) {
    await runSourceCheck(source);
  }
  return sources.length;
}

let schedulerStarted = false;
function startDocumentMonitor() {
  if (schedulerStarted || process.env.DOCUMENT_MONITOR_ENABLED === "false") return;
  schedulerStarted = true;

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runDueSources();
    } catch (error) {
      console.error("[documentMonitor] tick failed:", error?.message);
    } finally {
      ticking = false;
    }
  };

  setTimeout(tick, SCHEDULER_FIRST_TICK_MS).unref();
  setInterval(tick, SCHEDULER_TICK_MS).unref();
}

module.exports = {
  extractDocumentLinks,
  isDocumentLink,
  filenameFromResponse,
  runSourceCheck,
  claimSourceNow,
  claimDueSources,
  runDueSources,
  startDocumentMonitor,
  SKIPPED_PREFIX,
};
