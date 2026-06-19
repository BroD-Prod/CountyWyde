/**
 * backfillMilvus.js
 *
 * One-time migration script. Reads all chunks from uploads.json that have
 * embeddings and upserts them into Milvus. Safe to re-run: upsert is idempotent.
 *
 * Usage:
 *   node src/scripts/backfillMilvus.js
 */

require("dotenv").config();
const { readChunks } = require("../lib/uploadStore");
const { upsertChunks } = require("../lib/vectorStore");

const BATCH_SIZE = 200;

async function main() {
    if (!process.env.MILVUS_ADDRESS && !process.env.GEMINI_API_KEY) {
        console.warn("Warning: MILVUS_ADDRESS not set — defaulting to localhost:19530");
    }

    const uploads = readChunks();

    const withEmbeddings = uploads.filter(
        (item) => Array.isArray(item.embedding) && item.embedding.length > 0,
    );

    if (withEmbeddings.length === 0) {
        console.log("No chunks with embeddings found. Run backfill:embeddings first.");
        return;
    }

    console.log(`Found ${withEmbeddings.length} embedded chunks out of ${uploads.length} total.`);

    const chunks = withEmbeddings.map((item) => ({
        chunkId: String(item.id),
        county: String(item.county || ""),
        state: String(item.state || ""),
        source: String(item.source || ""),
        embedding: item.embedding,
    }));

    let totalInserted = 0;
    let totalSkipped = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const { inserted, skipped } = await upsertChunks(batch, BATCH_SIZE);
        totalInserted += inserted;
        totalSkipped += skipped;

        const done = Math.min(i + BATCH_SIZE, chunks.length);
        console.log(`  [${done}/${chunks.length}] inserted=${inserted} skipped=${skipped}`);
    }

    console.log(
        `\nBackfill complete. total_inserted=${totalInserted}, total_skipped=${totalSkipped}`,
    );
}

main().catch((error) => {
    console.error("Backfill failed:", error.message || error);
    process.exitCode = 1;
});
