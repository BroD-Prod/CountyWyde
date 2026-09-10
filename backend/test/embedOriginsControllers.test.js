require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.GEMINI_API_KEY = "test";
process.env.ADMIN_KEY = "test-admin-key";

const db = require("../src/lib/db");
const {
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
