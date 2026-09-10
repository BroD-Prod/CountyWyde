require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.GEMINI_API_KEY = "test";

const db = require("../src/lib/db");
const {
    buildVideoTranscriptTimestampLink,
    resolveEmbedAccess,
    postSearch,
} = require("../src/controllers/searchControllers");

function makeSearchRes() {
    return {
        statusCode: 200,
        body: null,
        setHeader() {},
        end(data) {
            this.body = data ? JSON.parse(data) : null;
        },
    };
}

async function callPostSearch(headers, payload) {
    const req = new EventEmitter();
    req.headers = headers;
    const res = makeSearchRes();
    const promise = postSearch(req, res);
    req.emit("data", Buffer.from(JSON.stringify(payload)));
    req.emit("end");
    await promise;
    return res;
}

test("buildVideoTranscriptTimestampLink returns a timestamp and transcript link for video sources", () => {
    const result = buildVideoTranscriptTimestampLink({
        id: "chunk-1",
        source: "County meeting",
        parsedType: "whisper_transcript",
        record: {
            structured: {
                segments: [
                    { index: 0, start: 80, end: 95, text: "Intro" },
                    { index: 1, start: 110, end: 130, text: "Main discussion" },
                ],
            },
            metadata: {
                videoId: "video-123",
            },
        },
    });

    assert.deepEqual(result, {
        timestamp: "01:20",
        timestampSeconds: 80,
        transcriptSnippet: "Intro",
        transcriptSegments: [
            { start: 80, text: "Intro" },
            { start: 110, text: "Main discussion" },
        ],
        videoId: "video-123",
    });
});

test("buildVideoTranscriptTimestampLink returns null for non-video sources", () => {
    const result = buildVideoTranscriptTimestampLink({
        id: "chunk-2",
        source: "PDF document",
        parsedType: "pdf",
    });

    assert.equal(result, null);
});

test("buildVideoTranscriptTimestampLink normalizes millisecond offsets", () => {
    const result = buildVideoTranscriptTimestampLink({
        id: "chunk-3",
        source: "County meeting",
        parsedType: "whisper_transcript",
        record: {
            structured: {
                segments: [
                    { index: 0, start: 610000, end: 620000, text: "Budget discussion" },
                    { index: 1, start: 695000, end: 710000, text: "Road repairs" },
                ],
            },
            metadata: {
                videoId: "video-456",
            },
        },
    });

    assert.equal(result.timestamp, "10:10");
    assert.deepEqual(result.transcriptSegments, [
        { start: 610, text: "Budget discussion" },
        { start: 695, text: "Road repairs" },
    ]);
});

test("resolveEmbedAccess reports isEmbed: false when no X-Embed-Referrer header is present", async () => {
    const result = await resolveEmbedAccess({ headers: {} });
    assert.deepEqual(result, { isEmbed: false, restriction: null });
});

test("resolveEmbedAccess reports isEmbed: true with a null restriction for an unregistered embed origin", async () => {
    const result = await resolveEmbedAccess({
        headers: { "x-embed-referrer": "https://unregistered-embed.example.com/page" },
    });
    assert.deepEqual(result, { isEmbed: true, restriction: null });
});

test("resolveEmbedAccess reports isEmbed: true with a null restriction for a malformed referrer", async () => {
    const result = await resolveEmbedAccess({
        headers: { "x-embed-referrer": "not-a-valid-url" },
    });
    assert.deepEqual(result, { isEmbed: true, restriction: null });
});

test("resolveEmbedAccess returns the county for a registered, non-revoked origin, and a null restriction once revoked", async (t) => {
    const origin = `https://test-embed-${Date.now()}.example.com`;
    let insertedId = null;

    t.after(async () => {
        if (insertedId) {
            await db.prepare("DELETE FROM embed_origins WHERE id = ?").run(insertedId);
        }
    });

    const inserted = await db
        .prepare(
            `INSERT INTO embed_origins (label, origin, state, county, revoked, created_at)
             VALUES (?, ?, ?, ?, FALSE, ?)
             RETURNING id`,
        )
        .get("Test Partner", origin, "IN", "Pulaski", Date.now());
    insertedId = inserted.id;

    const active = await resolveEmbedAccess({
        headers: { "x-embed-referrer": `${origin}/widget` },
    });
    assert.deepEqual(active, {
        isEmbed: true,
        restriction: { state: "IN", county: "Pulaski" },
    });

    await db.prepare("UPDATE embed_origins SET revoked = TRUE WHERE id = ?").run(insertedId);

    const afterRevoke = await resolveEmbedAccess({
        headers: { "x-embed-referrer": `${origin}/widget` },
    });
    assert.deepEqual(afterRevoke, { isEmbed: true, restriction: null });
});

// Regression test for a real bug: revoking an embed origin used to make
// postSearch treat the request as unrestricted (able to search ANY county)
// instead of rejecting it, because a null restriction was only checked
// together with a truthy embedRestriction. A revoked or unknown embed
// origin must now be rejected outright.
test("postSearch rejects a revoked embed origin instead of granting unrestricted access", async (t) => {
    const origin = `https://test-embed-revoked-${Date.now()}.example.com`;
    let insertedId = null;

    t.after(async () => {
        if (insertedId) {
            await db.prepare("DELETE FROM embed_origins WHERE id = ?").run(insertedId);
        }
    });

    const inserted = await db
        .prepare(
            `INSERT INTO embed_origins (label, origin, state, county, revoked, created_at)
             VALUES (?, ?, ?, ?, TRUE, ?)
             RETURNING id`,
        )
        .get("Revoked Partner", origin, "IN", "Pulaski", Date.now());
    insertedId = inserted.id;

    const res = await callPostSearch(
        { "x-embed-referrer": `${origin}/widget` },
        { prompt: "test", state: "IN", county: "Marion" },
    );

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not authorized/);
});

test("postSearch rejects an unregistered embed origin instead of granting unrestricted access", async () => {
    const res = await callPostSearch(
        { "x-embed-referrer": "https://never-registered-embed.example.com/widget" },
        { prompt: "test", state: "IN", county: "Marion" },
    );

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not authorized/);
});
