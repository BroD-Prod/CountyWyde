require("dotenv").config();
const { attachEmbeddings } = require("../lib/embeddings");
const { readChunks, updateChunkEmbedding } = require("../lib/uploadStore");

const EMBEDDING_CONCURRENCY = 4;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const all = readChunks();
  const pending = all.filter(
    (item) => !Array.isArray(item.embedding) || item.embedding.length === 0,
  );

  if (pending.length === 0) {
    console.log("No chunks require backfill.");
    return;
  }

  await attachEmbeddings(pending, { concurrency: EMBEDDING_CONCURRENCY });

  let updated = 0;
  let failed = 0;
  for (const item of pending) {
    if (Array.isArray(item.embedding) && item.embedding.length > 0) {
      updateChunkEmbedding(item.id, item.embedding);
      updated += 1;
    } else {
      failed += 1;
    }
  }

  console.log(
    `Backfill complete. updated=${updated}, failed=${failed}, total=${all.length}`,
  );
}

main().catch((error) => {
  console.error(error.message || "Backfill failed");
  process.exitCode = 1;
});
