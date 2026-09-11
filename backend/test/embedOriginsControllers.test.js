require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.GEMINI_API_KEY = "test";
process.env.ADMIN_KEY = "test-admin-key";

const db = require("../src/lib/db");
const {
  getAllowedEmbedOrigins,
  getEmbedOrigins,
  createEmbedOrigin,
  revokeEmbedOrigin,
} = require("../src/controllers/embedOriginsControllers");

function makeReq(headers = {}, bodyObj) {
  const req = new EventEmitter();
  req.headers = headers;
  if (bodyObj !== undefined) {
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
      req.emit("end");
    });
  } else {
    queueMicrotask(() => req.emit("end"));
  }
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

test("embed origin admin endpoints reject requests without a valid admin key", async () => {
  const res = makeRes();
  await getEmbedOrigins(makeReq({}), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Forbidden" });
});

test("createEmbedOrigin validates its payload before touching the database", async () => {
  const res = makeRes();
  await createEmbedOrigin(
    makeReq({ "x-admin-key": "test-admin-key" }, { label: "Missing fields" }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /required/);
});

test("createEmbedOrigin creates a row, getEmbedOrigins lists it, and revokeEmbedOrigin revokes it", async (t) => {
  const origin = `https://test-embed-${Date.now()}.example.com`;
  let createdId = null;

  t.after(async () => {
    if (createdId) {
      await db.prepare("DELETE FROM embed_origins WHERE id = ?").run(createdId);
    }
  });

  const createRes = makeRes();
  await createEmbedOrigin(
    makeReq(
      { "x-admin-key": "test-admin-key" },
      { label: "Test Partner", origin, state: "IN", county: "Pulaski" },
    ),
    createRes,
  );
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.body.embedOrigin.origin, origin);
  assert.equal(createRes.body.embedOrigin.revoked, false);
  createdId = createRes.body.embedOrigin.id;

  const listRes = makeRes();
  await getEmbedOrigins(makeReq({ "x-admin-key": "test-admin-key" }), listRes);
  assert.equal(listRes.statusCode, 200);
  assert.ok(
    listRes.body.embedOrigins.some((row) => row.id === createdId),
    "created embed origin should appear in the list",
  );

  const revokeRes = makeRes();
  await revokeEmbedOrigin(
    makeReq({ "x-admin-key": "test-admin-key" }, { id: createdId }),
    revokeRes,
  );
  assert.equal(revokeRes.statusCode, 200);

  const afterRevoke = await db
    .prepare("SELECT revoked FROM embed_origins WHERE id = ?")
    .get(createdId);
  assert.equal(afterRevoke.revoked, true);
});

test("revokeEmbedOrigin returns 404 for an unknown id", async () => {
  const res = makeRes();
  await revokeEmbedOrigin(
    makeReq({ "x-admin-key": "test-admin-key" }, { id: 999999999 }),
    res,
  );
  assert.equal(res.statusCode, 404);
});

test("createEmbedOrigin rejects a state that isn't a recognized state", async () => {
  const res = makeRes();
  await createEmbedOrigin(
    makeReq(
      { "x-admin-key": "test-admin-key" },
      {
        label: "Bad State",
        origin: `https://test-embed-badstate-${Date.now()}.example.com`,
        state: "Not A Real State",
        county: "Pulaski",
      },
    ),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /state/);
});

test("createEmbedOrigin rejects a malformed county name", async () => {
  const res = makeRes();
  await createEmbedOrigin(
    makeReq(
      { "x-admin-key": "test-admin-key" },
      {
        label: "Bad County",
        origin: `https://test-embed-badcounty-${Date.now()}.example.com`,
        state: "IN",
        county: "123",
      },
    ),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /county/);
});

test("createEmbedOrigin returns 409 when an active row already exists for the origin", async (t) => {
  const origin = `https://test-embed-duplicate-${Date.now()}.example.com`;
  let createdId = null;

  t.after(async () => {
    if (createdId) {
      await db.prepare("DELETE FROM embed_origins WHERE id = ?").run(createdId);
    }
  });

  const firstRes = makeRes();
  await createEmbedOrigin(
    makeReq(
      { "x-admin-key": "test-admin-key" },
      { label: "First", origin, state: "IN", county: "Pulaski" },
    ),
    firstRes,
  );
  assert.equal(firstRes.statusCode, 201);
  createdId = firstRes.body.embedOrigin.id;

  const secondRes = makeRes();
  await createEmbedOrigin(
    makeReq(
      { "x-admin-key": "test-admin-key" },
      { label: "Second", origin, state: "IN", county: "Marion" },
    ),
    secondRes,
  );
  assert.equal(secondRes.statusCode, 409);
});

test("getAllowedEmbedOrigins is public, and lists active origins but not revoked ones", async (t) => {
  const activeOrigin = `https://test-embed-allowed-active-${Date.now()}.example.com`;
  const revokedOrigin = `https://test-embed-allowed-revoked-${Date.now()}.example.com`;
  const insertedIds = [];

  t.after(async () => {
    for (const id of insertedIds) {
      await db.prepare("DELETE FROM embed_origins WHERE id = ?").run(id);
    }
  });

  const active = await db
    .prepare(
      `INSERT INTO embed_origins (label, origin, state, county, revoked, created_at)
       VALUES (?, ?, ?, ?, FALSE, ?)
       RETURNING id`,
    )
    .get("Active", activeOrigin, "IN", "Pulaski", Date.now());
  insertedIds.push(active.id);

  const revoked = await db
    .prepare(
      `INSERT INTO embed_origins (label, origin, state, county, revoked, created_at)
       VALUES (?, ?, ?, ?, TRUE, ?)
       RETURNING id`,
    )
    .get("Revoked", revokedOrigin, "IN", "Marion", Date.now());
  insertedIds.push(revoked.id);

  // No X-Admin-Key header at all — this endpoint must not require one.
  const res = makeRes();
  await getAllowedEmbedOrigins(makeReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.origins.includes(activeOrigin));
  assert.ok(!res.body.origins.includes(revokedOrigin));
});
