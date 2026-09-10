require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GEMINI_API_KEY = "test";

const db = require("../src/lib/db");
const {
    buildVideoTranscriptTimestampLink,
    getEmbedRestriction,
} = require("../src/controllers/searchControllers");

test("buildVideoTranscriptTimestampLink returns a timestamp and transcript link for video sources", () => {
    const result = buildVideoTranscriptTimestampLink({
        id: "chunk-1",
        source: "County meeting",
        parsedType: "whisper_transcript",
        structured: {
            segments: [
                { index: 0, start: 80, end: 95, text: "Intro" },
                { index: 1, start: 110, end: 130, text: "Main discussion" },
            ],
        },
        metadata: {
            videoId: "video-123",
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
        structured: {
            segments: [
                { index: 0, start: 610000, end: 620000, text: "Budget discussion" },
                { index: 1, start: 695000, end: 710000, text: "Road repairs" },
            ],
        },
        metadata: {
            videoId: "video-456",
        },
    });

    assert.equal(result.timestamp, "10:10");
    assert.deepEqual(result.transcriptSegments, [
        { start: 610, text: "Budget discussion" },
        { start: 695, text: "Road repairs" },
    ]);
});

test("getEmbedRestriction returns null when no X-Embed-Referrer header is present", async () => {
    const result = await getEmbedRestriction({ headers: {} });
    assert.equal(result, null);
});

test("getEmbedRestriction returns null for an unregistered embed origin", async () => {
    const result = await getEmbedRestriction({
        headers: { "x-embed-referrer": "https://unregistered-embed.example.com/page" },
    });
    assert.equal(result, null);
});

test("getEmbedRestriction returns the county for a registered, non-revoked origin, and null once revoked", async (t) => {
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

    const restriction = await getEmbedRestriction({
        headers: { "x-embed-referrer": `${origin}/widget` },
    });
    assert.deepEqual(restriction, { state: "IN", county: "Pulaski" });

    await db.prepare("UPDATE embed_origins SET revoked = TRUE WHERE id = ?").run(insertedId);

    const afterRevoke = await getEmbedRestriction({
        headers: { "x-embed-referrer": `${origin}/widget` },
    });
    assert.equal(afterRevoke, null);
});
