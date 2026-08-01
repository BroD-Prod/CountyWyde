const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GEMINI_API_KEY = "test";

const { buildVideoTranscriptTimestampLink } = require("../src/controllers/searchControllers");

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
