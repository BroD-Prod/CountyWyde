require("dotenv").config();
const { attachEmbeddings } = require("../lib/embeddings");
const { readUploads, writeUploads } = require("../lib/uploadStore");

const EMBEDDING_CONCURRENCY = 4;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const uploads = await readUploads();
  const pending = uploads.filter(
    (item) => !Array.isArray(item.embedding) || item.embedding.length === 0,
  );

  if (pending.length === 0) {
    console.log("No chunks require backfill.");
    return;
  }

  await attachEmbeddings(pending, { concurrency: EMBEDDING_CONCURRENCY });

  const updated = pending.filter(
    (item) => Array.isArray(item.embedding) && item.embedding.length > 0,
  ).length;
  const failed = pending.length - updated;

  await writeUploads(uploads);
  console.log(
    `Backfill complete. updated=${updated}, failed=${failed}, total=${uploads.length}`,
  );
}

main().catch((error) => {
  console.error(error.message || "Backfill failed");
  process.exitCode = 1;
});
