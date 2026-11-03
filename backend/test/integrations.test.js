// Tests for county document integrations: account-page key/source management,
// the key-authenticated push API, link discovery, SSRF guards, and the website
// monitor end to end against a local fixture site.
//
// Run against a disposable database, e.g.:
//   DATABASE_URL=postgres://.../countywyde_test node --test test/integrations.test.js
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

process.env.GEMINI_API_KEY = "test";
process.env.MILVUS_ADDRESS = "";
process.env.DOCUMENT_MONITOR_ENABLED = "false";

// Stub embeddings so tests never call Gemini.
const embeddingsPath = path.join(__dirname, "../src/lib/embeddings.js");
require.cache[embeddingsPath] = {
  id: embeddingsPath,
  filename: embeddingsPath,
  loaded: true,
  exports: {
    attachEmbeddings: async (records) => {
      for (const record of records) record.embedding = [0.1, 0.2, 0.3];
      return records;
    },
  },
};

const db = require("../src/lib/db");
const integrations = require("../src/controllers/integrationsControllers");
const publicApi = require("../src/controllers/publicApiControllers");
const crawler = require("../src/lib/sourceCrawler");
const { parsePublicUrl, isBlockedAddress } = require("../src/lib/safeFetch");

const RUN = crypto.randomBytes(4).toString("hex");
const COUNTY_A = `Testa${RUN.replace(/\d/g, "x")}`;
const COUNTY_B = `Testb${RUN.replace(/\d/g, "x")}`;

function makeReq({ headers = {}, body, url = "/" } = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.url = url;
  // Handlers authenticate before reading the body, so only emit the body once
  // someone is actually listening for it.
  let emitted = false;
  req.on("newListener", (event) => {
    if (event !== "end" || emitted) return;
    emitted = true;
    setImmediate(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

async function call(handler, reqOptions, ...args) {
  const res = makeRes();
  await handler(makeReq(reqOptions), res, ...args);
  return res;
}

async function createUser(county, stateAbbr, { approved = true } = {}) {
  const state = await db.prepare("SELECT id FROM states WHERE abbreviation = ?").get(stateAbbr);
  const account = await db
    .prepare(
      `INSERT INTO accounts (username, password_hash, county, state_id, approved)
       VALUES (?, 'x', ?, ?, ?) RETURNING id`,
    )
    .get(`it-${RUN}-${county}-${crypto.randomBytes(3).toString("hex")}`, county, state.id, approved);
  const token = crypto.randomBytes(16).toString("hex");
  await db
    .prepare("INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(
      account.id,
      crypto.createHash("sha256").update(token).digest("hex"),
      Date.now() + 3600000,
      Date.now(),
    );
  return { id: account.id, cookie: `session_token=${token}` };
}

let fixtureServer;
let fixtureBase;
const fixtureFiles = {};

test.before(async () => {
  process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = "true";
  fixtureServer = http.createServer((req, res) => {
    const file = fixtureFiles[req.url];
    if (!file) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": file.type, ...(file.headers || {}) });
    res.end(file.body);
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
});

test.after(async () => {
  await db.prepare("DELETE FROM upload_chunks WHERE county IN (?, ?)").run(COUNTY_A, COUNTY_B);
  await db.prepare("DELETE FROM document_sources WHERE county IN (?, ?)").run(COUNTY_A, COUNTY_B);
  await db.prepare("DELETE FROM accounts WHERE username LIKE ?").run(`it-${RUN}-%`);
  fixtureServer.close();
  await db.pool.end();
});

test("SSRF guard rejects internal and non-http URLs", () => {
  const saved = process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS;
  process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = "false";
  try {
    for (const bad of [
      "file:///etc/passwd",
      "ftp://county.gov/a.pdf",
      "http://127.0.0.1/a.pdf",
      "http://169.254.169.254/latest/meta-data",
      "http://10.1.2.3/",
      "http://[::1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://localhost/",
      "http://metadata.internal/",
      "https://county.gov:8443/",
      "https://user:pass@county.gov/",
      "not a url",
    ]) {
      assert.throws(() => parsePublicUrl(bad), /./, bad);
    }
    assert.equal(parsePublicUrl("https://www.county.gov/agendas#top").toString(), "https://www.county.gov/agendas");
    assert.equal(isBlockedAddress("8.8.8.8"), false);
    assert.equal(isBlockedAddress("192.168.1.1"), true);
    assert.equal(isBlockedAddress("fd00::1"), true);
  } finally {
    process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = saved;
  }
});

test("extracts document links from HTML pages, RSS feeds and sitemaps", () => {
  const html = Buffer.from(`
    <a href="/files/agenda.pdf">Agenda</a>
    <a href='minutes.docx'>Minutes</a>
    <a href=/DocumentCenter/View/1234/Budget-2026>Budget</a>
    <a href="/about-us">About</a>
    <a href="mailto:clerk@county.gov">Email</a>
    <a href="/files/agenda.pdf#page=2">Dup</a>
    <a href="https://cdn.example.com/x/report.CSV?v=2&amp;dl=1">Report</a>`);
  assert.deepEqual(
    crawler.extractDocumentLinks(html, "text/html", "https://county.gov/meetings/"),
    [
      "https://county.gov/files/agenda.pdf",
      "https://county.gov/meetings/minutes.docx",
      "https://county.gov/DocumentCenter/View/1234/Budget-2026",
      "https://cdn.example.com/x/report.CSV?v=2&dl=1",
    ],
  );

  const rss = Buffer.from(`<?xml version="1.0"?><rss><channel>
    <item><link>https://county.gov/news/story</link>
      <enclosure url="https://county.gov/media/notice" type="application/pdf"/></item>
    <item><link><![CDATA[https://county.gov/AgendaCenter/ViewFile/Agenda/_11042026-99]]></link></item>
  </channel></rss>`);
  assert.deepEqual(
    crawler.extractDocumentLinks(rss, "application/rss+xml", "https://county.gov/rss"),
    [
      "https://county.gov/media/notice",
      "https://county.gov/AgendaCenter/ViewFile/Agenda/_11042026-99",
    ],
  );

  const sitemap = Buffer.from(`<urlset><url><loc>https://county.gov/a.pdf</loc></url>
    <url><loc>https://county.gov/page</loc></url></urlset>`);
  assert.deepEqual(
    crawler.extractDocumentLinks(sitemap, "application/xml", "https://county.gov/sitemap.xml"),
    ["https://county.gov/a.pdf"],
  );
});

test("integration management requires a signed-in, approved account", async () => {
  const handlers = [
    [integrations.getIntegrations],
    [integrations.createApiKey, { label: "x" }],
    [integrations.createSource, { url: "https://county.gov" }],
    [integrations.revokeApiKey, undefined, "1"],
    [integrations.deleteSource, undefined, "1"],
    [integrations.checkSourceNow, undefined, "1"],
  ];
  for (const [handler, body, id] of handlers) {
    const res = await call(handler, { body }, id);
    assert.equal(res.statusCode, 401, handler.name);
  }

  const pending = await createUser(COUNTY_A, "OH", { approved: false });
  const res = await call(integrations.createApiKey, {
    headers: { cookie: pending.cookie },
    body: { label: "x" },
  });
  assert.equal(res.statusCode, 403);
});

test("API keys: create, push/replace/list/delete documents, county isolation, revoke", async () => {
  const userA = await createUser(COUNTY_A, "OH");
  const userB = await createUser(COUNTY_B, "OH");

  const created = await call(integrations.createApiKey, {
    headers: { cookie: userA.cookie },
    body: { label: "CMS" },
  });
  assert.equal(created.statusCode, 201);
  const key = created.body.key;
  assert.match(key, /^cw_live_/);
  assert.ok(key.startsWith(created.body.apiKey.keyPrefix));

  const stored = await db.prepare("SELECT key_hash FROM county_api_keys WHERE id = ?").get(created.body.apiKey.id);
  assert.notEqual(stored.key_hash, key, "raw key must never be stored");

  // County B's user can't see or revoke county A's key.
  const listB = await call(integrations.getIntegrations, { headers: { cookie: userB.cookie } });
  assert.equal(listB.body.apiKeys.length, 0);
  const revokeByB = await call(
    integrations.revokeApiKey,
    { headers: { cookie: userB.cookie } },
    created.body.apiKey.id,
  );
  assert.equal(revokeByB.statusCode, 404);

  const auth = { authorization: `Bearer ${key}` };
  assert.equal((await call(publicApi.listDocuments, {})).statusCode, 401);
  assert.equal(
    (await call(publicApi.listDocuments, { headers: { authorization: "Bearer cw_live_nope" } })).statusCode,
    401,
  );

  const push = (text) =>
    call(publicApi.pushDocument, {
      headers: auth,
      body: { name: "notice.txt", type: "text/plain", base64: Buffer.from(text).toString("base64") },
    });
  const first = await push("Board meeting moved to Thursday.");
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  const second = await push("Board meeting moved to Friday.");
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.replaced, true);

  const rows = await db.prepare("SELECT text FROM upload_chunks WHERE county = ?").all(COUNTY_A);
  assert.deepEqual(rows.map((r) => r.text), ["Board meeting moved to Friday."]);

  const unsupported = await call(publicApi.pushDocument, {
    headers: auth,
    body: { name: "a.exe", base64: Buffer.from("MZ").toString("base64") },
  });
  assert.equal(unsupported.statusCode, 415);

  // Push by URL: CountyWyde fetches the file itself.
  fixtureFiles["/pushed/minutes.txt"] = { type: "text/plain", body: "Minutes of the board." };
  const byUrl = await call(publicApi.pushDocument, {
    headers: auth,
    body: { url: `${fixtureBase}/pushed/minutes.txt` },
  });
  assert.equal(byUrl.statusCode, 201, JSON.stringify(byUrl.body));
  assert.equal(byUrl.body.name, "minutes.txt");

  const list = await call(publicApi.listDocuments, { headers: auth });
  assert.deepEqual(list.body.documents.map((d) => d.name).sort(), ["minutes.txt", "notice.txt"]);

  const del = await call(publicApi.deleteDocument, { headers: auth, url: "/api/v1/documents?name=notice.txt" });
  assert.equal(del.statusCode, 200);
  const delAgain = await call(publicApi.deleteDocument, { headers: auth, url: "/api/v1/documents?name=notice.txt" });
  assert.equal(delAgain.statusCode, 404);

  const revoke = await call(
    integrations.revokeApiKey,
    { headers: { cookie: userA.cookie } },
    created.body.apiKey.id,
  );
  assert.equal(revoke.statusCode, 200);
  assert.equal((await call(publicApi.listDocuments, { headers: auth })).statusCode, 401);
});

test("a key stops working if its owner moves to another county", async () => {
  const user = await createUser(COUNTY_A, "OH");
  const created = await call(integrations.createApiKey, {
    headers: { cookie: user.cookie },
    body: { label: "temp" },
  });
  const auth = { authorization: `Bearer ${created.body.key}` };
  assert.equal((await call(publicApi.listDocuments, { headers: auth })).statusCode, 200);
  await db.prepare("UPDATE accounts SET county = ? WHERE id = ?").run(COUNTY_B, user.id);
  assert.equal((await call(publicApi.listDocuments, { headers: auth })).statusCode, 401);
});

test("website monitor ingests new documents, skips unchanged, re-indexes changed", async () => {
  const user = await createUser(COUNTY_A, "OH");
  fixtureFiles["/agendas"] = {
    type: "text/html",
    body: `<h1>Agendas</h1>
      <a href="/files/agenda-nov.txt">November agenda</a>
      <a href="/DocumentCenter/View/77/Budget">Budget</a>
      <a href="/DocumentCenter/View/78/Photo">Photo</a>
      <a href="/contact">Contact</a>`,
  };
  fixtureFiles["/files/agenda-nov.txt"] = { type: "text/plain", body: "Agenda: road repairs." };
  fixtureFiles["/DocumentCenter/View/77/Budget"] = {
    type: "text/plain; charset=utf-8",
    body: "Budget: 2026 general fund.",
  };
  fixtureFiles["/DocumentCenter/View/78/Photo"] = { type: "image/jpeg", body: "\xff\xd8" };

  const badUrl = await call(integrations.createSource, {
    headers: { cookie: user.cookie },
    body: { url: "javascript:alert(1)" },
  });
  assert.equal(badUrl.statusCode, 400);

  const created = await call(integrations.createSource, {
    headers: { cookie: user.cookie },
    body: { label: "Agendas", url: `${fixtureBase}/agendas`, checkIntervalHours: 24 },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  const sourceId = created.body.source.id;

  const duplicate = await call(integrations.createSource, {
    headers: { cookie: user.cookie },
    body: { url: `${fixtureBase}/agendas` },
  });
  assert.equal(duplicate.statusCode, 409);

  // createSource kicks off a background check; wait for it to settle.
  const waitForCheck = async () => {
    for (let i = 0; i < 100; i += 1) {
      const row = await db.prepare("SELECT last_status FROM document_sources WHERE id = ?").get(sourceId);
      if (row.last_status !== "checking") return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("check did not finish");
  };
  await waitForCheck();

  const sourceView = (await call(integrations.getIntegrations, { headers: { cookie: user.cookie } })).body.sources[0];
  assert.equal(sourceView.lastStatus, "ok");
  assert.equal(sourceView.documentCount, 2);
  assert.equal(sourceView.lastNewCount, 2);

  const chunks = await db
    .prepare(
      "SELECT source, metadata FROM upload_chunks WHERE county = ? AND source <> 'minutes.txt' ORDER BY source",
    )
    .all(COUNTY_A);
  assert.deepEqual(chunks.map((c) => c.source), ["Budget.txt", "agenda-nov.txt"]);
  assert.equal(JSON.parse(chunks[1].metadata).sourceUrl, `${fixtureBase}/files/agenda-nov.txt`);

  const docs = await call(integrations.getSourceDocuments, { headers: { cookie: user.cookie } }, sourceId);
  const photo = docs.body.documents.find((d) => d.url.endsWith("/78/Photo"));
  assert.match(photo.error, /^skipped: not a supported document type/);

  // Unchanged re-check: nothing new.
  let claimed = await crawler.claimSourceNow(sourceId, COUNTY_A, "OH");
  let summary = await crawler.runSourceCheck(claimed);
  assert.equal(summary.new + summary.updated, 0);

  // Content changes -> replaced, not duplicated.
  fixtureFiles["/files/agenda-nov.txt"].body = "Agenda: road repairs and bridge inspection.";
  claimed = await crawler.claimSourceNow(sourceId, COUNTY_A, "OH");
  summary = await crawler.runSourceCheck(claimed);
  assert.equal(summary.updated, 1);
  const agendaChunks = await db
    .prepare("SELECT text FROM upload_chunks WHERE county = ? AND source = 'agenda-nov.txt'")
    .all(COUNTY_A);
  assert.deepEqual(agendaChunks.map((c) => c.text), ["Agenda: road repairs and bridge inspection."]);

  // Another county's user can't see, trigger, or delete this source.
  const other = await createUser(COUNTY_B, "OH");
  assert.equal(
    (await call(integrations.checkSourceNow, { headers: { cookie: other.cookie } }, sourceId)).statusCode,
    404,
  );
  assert.equal(
    (await call(integrations.deleteSource, { headers: { cookie: other.cookie } }, sourceId)).statusCode,
    404,
  );

  const paused = await call(
    integrations.updateSource,
    { headers: { cookie: user.cookie }, body: { active: false, checkIntervalHours: 168 } },
    sourceId,
  );
  assert.equal(paused.body.source.active, false);
  assert.equal(paused.body.source.checkIntervalHours, 168);

  const removed = await call(integrations.deleteSource, { headers: { cookie: user.cookie } }, sourceId);
  assert.equal(removed.statusCode, 200);
});

test("scheduler only claims sources that are due", async () => {
  const user = await createUser(COUNTY_B, "OH");
  const t = Date.now();
  const due = await db
    .prepare(
      `INSERT INTO document_sources (account_id, county, state, label, url, check_interval_hours, active, last_checked_at, last_status, created_at)
       VALUES (?, ?, 'OH', 'due', ?, 6, TRUE, ?, 'ok', ?) RETURNING id`,
    )
    .get(user.id, COUNTY_B, `${fixtureBase}/due-${RUN}`, t - 7 * 3600000, t);
  const notDue = await db
    .prepare(
      `INSERT INTO document_sources (account_id, county, state, label, url, check_interval_hours, active, last_checked_at, last_status, created_at)
       VALUES (?, ?, 'OH', 'fresh', ?, 6, TRUE, ?, 'ok', ?) RETURNING id`,
    )
    .get(user.id, COUNTY_B, `${fixtureBase}/fresh-${RUN}`, t - 3600000, t);
  const paused = await db
    .prepare(
      `INSERT INTO document_sources (account_id, county, state, label, url, check_interval_hours, active, last_checked_at, created_at)
       VALUES (?, ?, 'OH', 'paused', ?, 6, FALSE, NULL, ?) RETURNING id`,
    )
    .get(user.id, COUNTY_B, `${fixtureBase}/paused-${RUN}`, t);

  const claimed = (await crawler.claimDueSources(100)).map((s) => String(s.id));
  assert.ok(claimed.includes(String(due.id)));
  assert.ok(!claimed.includes(String(notDue.id)));
  assert.ok(!claimed.includes(String(paused.id)));
});
