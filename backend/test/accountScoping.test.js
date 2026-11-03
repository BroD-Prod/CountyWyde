// Regression tests for:
//   - boolean `approved` queries (forgot-password, pending list, approve, reject)
//     that compared a Postgres BOOLEAN to an integer and always errored
//   - upload list/delete scoped by state, not just county name
//   - users can't move their own account to another county; admins can, and
//     doing so revokes the account's API keys
//
// Run against a disposable database, e.g.:
//   DATABASE_URL=postgres://.../countywyde_test node --test test/accountScoping.test.js
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

process.env.GEMINI_API_KEY = "test";
process.env.MILVUS_ADDRESS = "";
process.env.ADMIN_KEY = "test-admin-key";

const emailPath = path.join(__dirname, "../src/lib/email.js");
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: { sendTwoFactorEmail: async () => {}, sendPasswordResetEmail: async () => {} },
};

const db = require("../src/lib/db");
const { insertChunks } = require("../src/lib/uploadStore");
const accounts = require("../src/controllers/accountControllers");
const uploads = require("../src/controllers/uploadFilesControllers");
const integrations = require("../src/controllers/integrationsControllers");

const RUN = crypto.randomBytes(4).toString("hex");
const COUNTY = `Samename${RUN.replace(/\d/g, "q")}`;
const OTHER_COUNTY = `Elsewhere${RUN.replace(/\d/g, "q")}`;

function makeReq({ headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.url = "/";
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
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return {
    statusCode: 200,
    body: null,
    done,
    setHeader() {},
    end(data) {
      this.body = data ? JSON.parse(data) : null;
      resolveDone();
    },
  };
}

// Some legacy handlers respond from inside a req.on("end") callback, so wait
// for res.end rather than for the handler's promise.
async function call(handler, reqOptions, ...args) {
  const res = makeRes();
  await handler(makeReq(reqOptions), res, ...args);
  await res.done;
  return res;
}

async function createUser(county, stateAbbr, { approved = true, admin = false } = {}) {
  const state = await db.prepare("SELECT id FROM states WHERE abbreviation = ?").get(stateAbbr);
  const username = `acct-${RUN}-${crypto.randomBytes(3).toString("hex")}@example.com`;
  const account = await db
    .prepare(
      `INSERT INTO accounts (username, password_hash, county, state_id, approved, is_admin)
       VALUES (?, 'x', ?, ?, ?, ?) RETURNING id`,
    )
    .get(username, county, state.id, approved, admin);
  const token = crypto.randomBytes(16).toString("hex");
  await db
    .prepare("INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(account.id, crypto.createHash("sha256").update(token).digest("hex"), Date.now() + 3600000, Date.now());
  return { id: account.id, username, cookie: `session_token=${token}` };
}

function chunk(source, county, state) {
  return {
    id: crypto.randomUUID(),
    source,
    text: `${source} in ${county}, ${state}`,
    parsedType: "text",
    county,
    state,
    chunkIndex: 0,
    chunkCount: 1,
    embedding: [0.1],
  };
}

test.after(async () => {
  await db.prepare("DELETE FROM upload_chunks WHERE county IN (?, ?)").run(COUNTY, OTHER_COUNTY);
  await db.prepare("DELETE FROM accounts WHERE username LIKE ?").run(`acct-${RUN}-%`);
  await db.pool.end();
});

test("forgot-password finds approved accounts (boolean approved column)", async () => {
  const user = await createUser(COUNTY, "OH");
  const res = await call(accounts.requestPasswordReset, { body: { email: user.username } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.resetUrl, "an approved account should get a reset link in dev");

  const pending = await createUser(COUNTY, "OH", { approved: false });
  const resPending = await call(accounts.requestPasswordReset, { body: { email: pending.username } });
  assert.equal(resPending.statusCode, 200);
  assert.equal(resPending.body.resetUrl, undefined, "unapproved accounts get no link");
});

test("admin can list, approve and reject pending accounts", async () => {
  const admin = { "x-admin-key": "test-admin-key" };
  const toApprove = await createUser(COUNTY, "OH", { approved: false });
  const toReject = await createUser(COUNTY, "OH", { approved: false });

  const list = await call(accounts.getPendingAccounts, { headers: admin });
  assert.equal(list.statusCode, 200, JSON.stringify(list.body));
  const ids = list.body.pending.map((row) => row.id);
  assert.ok(ids.includes(toApprove.id) && ids.includes(toReject.id));

  const approved = await call(accounts.approveAccount, { headers: admin, body: { id: toApprove.id } });
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));
  const row = await db.prepare("SELECT approved FROM accounts WHERE id = ?").get(toApprove.id);
  assert.equal(row.approved, true);

  const rejected = await call(accounts.rejectAccount, { headers: admin, body: { id: toReject.id } });
  assert.equal(rejected.statusCode, 200, JSON.stringify(rejected.body));
});

test("upload list and delete only touch the user's own state", async () => {
  const ohio = await createUser(COUNTY, "OH");
  await insertChunks([chunk("agenda.txt", COUNTY, "OH"), chunk("agenda.txt", COUNTY, "PA")]);

  const listed = await call(uploads.getUpload, { headers: { cookie: ohio.cookie } });
  assert.deepEqual(listed.body.uploads.map((u) => u.state), ["OH"]);

  const deleted = await call(uploads.deleteUpload, {
    headers: { cookie: ohio.cookie },
    body: { source: "agenda.txt" },
  });
  assert.equal(deleted.body.deleted, 1);

  const remaining = await db.prepare("SELECT state FROM upload_chunks WHERE county = ?").all(COUNTY);
  assert.deepEqual(remaining.map((r) => r.state), ["PA"], "Pennsylvania's copy must survive");

  // Deleting by id across states is refused too.
  const paChunk = await db.prepare("SELECT id FROM upload_chunks WHERE county = ? AND state = 'PA'").get(COUNTY);
  const byId = await call(uploads.deleteUpload, { headers: { cookie: ohio.cookie }, body: { id: paChunk.id } });
  assert.equal(byId.statusCode, 404);
});

test("users cannot change their own county; saving unchanged values still works", async () => {
  const user = await createUser(COUNTY, "OH");

  const same = await call(accounts.updateAccount, {
    headers: { cookie: user.cookie },
    body: { county: COUNTY.toLowerCase(), state: "OH" },
  });
  assert.equal(same.statusCode, 200, JSON.stringify(same.body));

  for (const body of [
    { county: OTHER_COUNTY, state: "OH" },
    { county: COUNTY, state: "PA" },
  ]) {
    const res = await call(accounts.updateAccount, { headers: { cookie: user.cookie }, body });
    assert.equal(res.statusCode, 403, JSON.stringify(body));
  }
  const row = await db.prepare("SELECT county FROM accounts WHERE id = ?").get(user.id);
  assert.equal(row.county, COUNTY);
});

test("admins reassign counties, which revokes the account's API keys", async () => {
  const user = await createUser(COUNTY, "OH");
  const key = await call(integrations.createApiKey, {
    headers: { cookie: user.cookie },
    body: { label: "cms" },
  });
  assert.equal(key.statusCode, 201);

  const notAdmin = await call(accounts.adminUpdateAccountCounty, {
    headers: { cookie: user.cookie },
    body: { id: user.id, county: OTHER_COUNTY, state: "OH" },
  });
  assert.equal(notAdmin.statusCode, 403);

  const moved = await call(accounts.adminUpdateAccountCounty, {
    headers: { "x-admin-key": "test-admin-key" },
    body: { id: user.id, county: OTHER_COUNTY, state: "OH" },
  });
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));

  const account = await db.prepare("SELECT county FROM accounts WHERE id = ?").get(user.id);
  assert.equal(account.county, OTHER_COUNTY);
  const keyRow = await db.prepare("SELECT revoked FROM county_api_keys WHERE id = ?").get(key.body.apiKey.id);
  assert.equal(keyRow.revoked, true);

  // A signed-in admin can also change their own county from the account page.
  const admin = await createUser(COUNTY, "OH", { admin: true });
  const selfMove = await call(accounts.updateAccount, {
    headers: { cookie: admin.cookie },
    body: { county: OTHER_COUNTY, state: "OH" },
  });
  assert.equal(selfMove.statusCode, 200, JSON.stringify(selfMove.body));
});

test("admin account search finds by email or county and is admin-only", async () => {
  const user = await createUser(COUNTY, "OH");

  const denied = await call(accounts.adminSearchAccounts, {
    headers: { cookie: user.cookie },
  });
  assert.equal(denied.statusCode, 403);

  const searchFor = (q) =>
    call(
      (req, res) => {
        req.url = `/admin/accounts?q=${encodeURIComponent(q)}`;
        return accounts.adminSearchAccounts(req, res);
      },
      { headers: { "x-admin-key": "test-admin-key" } },
    );

  const byEmail = await searchFor(user.username);
  assert.equal(byEmail.statusCode, 200);
  assert.deepEqual(byEmail.body.accounts.map((a) => a.id), [user.id]);
  assert.equal(byEmail.body.accounts[0].stateAbbreviation, "OH");

  const byCounty = await searchFor(COUNTY.toUpperCase());
  assert.ok(byCounty.body.accounts.some((a) => a.id === user.id));

  // LIKE wildcards in the query are treated literally, not as "match anything".
  const wildcard = await searchFor("%%");
  assert.equal(wildcard.statusCode, 200);
  assert.ok(!wildcard.body.accounts.some((a) => a.id === user.id));

  assert.equal((await searchFor("a")).statusCode, 400);
});
