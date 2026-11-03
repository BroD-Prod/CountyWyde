// Shared document ingest pipeline: parse -> (persist original PDF) -> chunk ->
// embed -> Milvus + Postgres. Used by manual uploads (/upload), the county
// push API (/api/v1/documents) and the website monitor (sourceCrawler.js), so
// a document is indexed identically no matter how it arrived.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  insertChunks,
  deleteChunksBySource,
  findChunkIds,
} = require("./uploadStore");
const { parseFile } = require("./fileParser");
const { attachEmbeddings } = require("./embeddings");
const { upsertChunks, deleteChunks } = require("./vectorStore");

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const EMBEDDING_CONCURRENCY = 4;
const DOCUMENTS_DIR = path.join(__dirname, "../../data/documents");

const MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
};
const SUPPORTED_MIME_TYPES = new Set([
  ...Object.values(MIME_BY_EXTENSION),
  "application/csv",
]);

function createId() {
  // random (not time-based) so document/video ids can't be enumerated or guessed
  return crypto.randomUUID();
}

function mimeFromName(name) {
  return MIME_BY_EXTENSION[path.extname(String(name || "")).toLowerCase()] || null;
}

// Resolve the type to parse a file as: an explicit supported type wins, then
// the file extension (servers often send application/octet-stream for PDFs).
function resolveMimeType(declaredType, name) {
  const declared = String(declaredType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (SUPPORTED_MIME_TYPES.has(declared)) return declared;
  return mimeFromName(name);
}

function assertEmbeddingsPresent(records) {
  const missingCount = records.filter(
    (record) => !Array.isArray(record.embedding) || record.embedding.length === 0,
  ).length;

  if (missingCount > 0) {
    throw new Error(
      `Embedding generation failed for ${missingCount} upload chunk(s)`,
    );
  }
}

async function persistOriginalPdf({ buffer, sourceName, mimeType, county, state }) {
  const documentId = createId();
  const safeSourceName = String(sourceName || "upload.pdf").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const filename = `${documentId}-${safeSourceName.endsWith(".pdf") ? safeSourceName : `${safeSourceName}.pdf`}`;

  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });

  const absolutePath = path.join(DOCUMENTS_DIR, filename);
  await fs.writeFile(absolutePath, buffer);

  return {
    documentId,
    originalName: sourceName,
    mimeType: mimeType || "application/pdf",
    size: buffer.length,
    county,
    state,
    storedFilename: filename,
    storedPath: absolutePath,
    createdAt: new Date().toISOString(),
  };
}

function normalizeChunkText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function findChunkEnd(text, start, maxEnd) {
  const slice = text.slice(start, maxEnd);
  const newlineBreak = slice.lastIndexOf("\n");
  if (newlineBreak >= CHUNK_SIZE * 0.5) {
    return start + newlineBreak + 1;
  }

  const sentenceBreak = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! "),
  );
  if (sentenceBreak >= CHUNK_SIZE * 0.5) {
    return start + sentenceBreak + 1;
  }

  const whitespaceBreak = slice.lastIndexOf(" ");
  if (whitespaceBreak >= CHUNK_SIZE * 0.5) {
    return start + whitespaceBreak + 1;
  }

  return maxEnd;
}

function chunkText(rawText, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const text = normalizeChunkText(rawText);
  if (!text) {
    return [];
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const maxEnd = Math.min(start + chunkSize, text.length);
    const end = findChunkEnd(text, start, maxEnd);
    const chunk = text.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    const nextStart = Math.max(end - overlap, start + 1);
    start = nextStart;
  }

  return chunks;
}

function normalizeParsed(parsed, source, county, state) {
  const sourceName = source || parsed?.metadata?.name || "unknown";

  if (Array.isArray(parsed.structured)) {
    return parsed.structured.map((item, index) => ({
      id: createId(),
      source: sourceName,
      text: typeof item === "object" ? JSON.stringify(item) : String(item),
      parsedType: parsed.parsedType,
      metadata: parsed.metadata,
      structured: item,
      county,
      state,
      rowIndex: index,
      chunkIndex: 0,
      chunkCount: 1,
      createdAt: new Date().toISOString(),
    }));
  }

  const baseText =
    parsed.rawText ||
    (parsed.structured ? JSON.stringify(parsed.structured, null, 2) : "");
  const chunks = chunkText(baseText);

  if (chunks.length === 0) {
    return [];
  }

  const chunkCount = chunks.length;

  return chunks.map((chunk, index) => ({
    id: createId(),
    source: sourceName,
    text: chunk,
    parsedType: parsed.parsedType,
    metadata: parsed.metadata,
    structured: parsed.structured,
    county,
    state,
    chunkIndex: index,
    chunkCount,
    createdAt: new Date().toISOString(),
  }));
}

/**
 * Parse one file into chunk records (not yet embedded or stored).
 * Throws an Error with a user-facing message on unsupported/empty content.
 * @returns {{ records: object[], documentSaved: boolean }}
 */
async function buildRecords({
  buffer,
  name,
  mimeType,
  size,
  county,
  state,
  sourceName,
  sourceUrl,
}) {
  if (!buffer?.length) {
    throw new Error(`Empty file: ${name || "unknown file"}`);
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const error = new Error(`File size exceeds limit for ${name || "unknown file"}`);
    error.code = "FILE_TOO_LARGE";
    throw error;
  }

  const parsed = await parseFile({
    originalname: name || "upload.bin",
    mimetype: mimeType || "application/octet-stream",
    buffer,
    size: size || buffer.length,
  });

  if (sourceUrl) {
    // Lets search results link back to the county's own copy of the file.
    parsed.metadata = { ...parsed.metadata, sourceUrl };
  }

  let documentMetadata = null;
  if (parsed.parsedType === "pdf") {
    documentMetadata = await persistOriginalPdf({
      buffer,
      sourceName: name || sourceName || "unknown.pdf",
      mimeType: mimeType || "application/pdf",
      county,
      state,
    });
  }

  if (!parsed.rawText && !parsed.structured) {
    throw new Error(`Parsed file has no content: ${name || "unknown file"}`);
  }

  const parsedRecords = normalizeParsed(parsed, sourceName || name, county, state);

  const records = documentMetadata
    ? parsedRecords.map((record) => ({
      ...record,
      documentId: documentMetadata.documentId,
      originalFileName: documentMetadata.originalName,
      originalMimeType: documentMetadata.mimeType,
      originalSize: documentMetadata.size,
      originalStoredFilename: documentMetadata.storedFilename,
      originalStoredPath: documentMetadata.storedPath,
      originalStoredAt: documentMetadata.createdAt,
    }))
    : parsedRecords;

  return { records, documentSaved: Boolean(documentMetadata) };
}

async function embedRecords(records) {
  await attachEmbeddings(records, { concurrency: EMBEDDING_CONCURRENCY });
  assertEmbeddingsPresent(records);
}

async function storeRecords(records) {
  // Milvus errors are non-fatal so uploads still succeed even if Milvus is
  // temporarily unavailable.
  try {
    await upsertChunks(
      records.map((r) => ({
        chunkId: r.id,
        county: r.county,
        state: r.state,
        source: r.source,
        embedding: r.embedding,
      })),
    );
  } catch (milvusError) {
    console.error("[vectorStore] upsert failed (non-fatal):", milvusError?.message);
  }

  await insertChunks(records);
}

/**
 * Remove every chunk for a source name within a county (Postgres + Milvus).
 * Pass state whenever it's known: county names repeat across states.
 */
async function removeSource(sourceName, county, state) {
  const ids = await findChunkIds({ source: sourceName, county, state });
  if (ids.length > 0) {
    try {
      await deleteChunks(ids);
    } catch { }
  }
  return deleteChunksBySource(sourceName, county, state);
}

/**
 * Ingest a single document end to end. With replace: true, any existing
 * chunks for the same source name in the county are swapped out — but only
 * after the new version has parsed and embedded successfully, so a bad
 * re-upload never wipes the good copy.
 */
async function ingestDocument({ replace = false, ...file }) {
  const { records } = await buildRecords(file);
  await embedRecords(records);

  let replaced = 0;
  if (replace) {
    replaced = await removeSource(file.sourceName || file.name, file.county, file.state);
  }
  await storeRecords(records);

  return {
    source: records[0]?.source || file.sourceName || file.name,
    added: records.length,
    replaced: replaced > 0,
  };
}

module.exports = {
  MAX_FILE_BYTES,
  SUPPORTED_MIME_TYPES,
  createId,
  chunkText,
  normalizeChunkText,
  mimeFromName,
  resolveMimeType,
  buildRecords,
  embedRecords,
  storeRecords,
  removeSource,
  ingestDocument,
};
