const db = require("./db");

// ---------------------------------------------------------------------------
// Row ↔ chunk object conversion
// ---------------------------------------------------------------------------

function rowToChunk(row) {
  return {
    id: row.id,
    source: row.source,
    text: row.text,
    parsedType: row.parsed_type,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    structured: row.structured ? JSON.parse(row.structured) : null,
    county: row.county,
    state: row.state,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    ...(row.row_index != null && { rowIndex: row.row_index }),
    ...(row.document_id != null && { documentId: row.document_id }),
    ...(row.original_file_name != null && {
      originalFileName: row.original_file_name,
    }),
    ...(row.original_mime_type != null && {
      originalMimeType: row.original_mime_type,
    }),
    ...(row.original_size != null && { originalSize: row.original_size }),
    ...(row.original_stored_filename != null && {
      originalStoredFilename: row.original_stored_filename,
    }),
    ...(row.original_stored_path != null && {
      originalStoredPath: row.original_stored_path,
    }),
    ...(row.original_stored_at != null && {
      originalStoredAt: row.original_stored_at,
    }),
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
    createdAt: row.created_at,
  };
}

function chunkToRow(chunk) {
  return {
    id: String(chunk.id),
    source: String(chunk.source || ""),
    text: String(chunk.text || ""),
    parsed_type: String(chunk.parsedType || "text"),
    metadata: chunk.metadata != null ? JSON.stringify(chunk.metadata) : null,
    structured:
      chunk.structured != null ? JSON.stringify(chunk.structured) : null,
    county: String(chunk.county || ""),
    state: String(chunk.state || ""),
    chunk_index: chunk.chunkIndex ?? 0,
    chunk_count: chunk.chunkCount ?? 1,
    row_index: chunk.rowIndex ?? null,
    document_id: chunk.documentId ?? null,
    original_file_name: chunk.originalFileName ?? null,
    original_mime_type: chunk.originalMimeType ?? null,
    original_size: chunk.originalSize ?? null,
    original_stored_filename: chunk.originalStoredFilename ?? null,
    original_stored_path: chunk.originalStoredPath ?? null,
    original_stored_at: chunk.originalStoredAt ?? null,
    embedding: Array.isArray(chunk.embedding)
      ? JSON.stringify(chunk.embedding)
      : null,
    created_at: chunk.createdAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read chunks with optional filters. All args are optional.
 * @param {{ county?: string, state?: string, documentId?: string, source?: string }} filter
 * @returns {object[]}
 */
async function readChunks({ county, state, documentId, source } = {}) {
  const conditions = [];
  const params = [];

  if (county) {
    conditions.push("LOWER(county) = LOWER(?)");
    params.push(county);
  }
  if (state) {
    conditions.push("LOWER(state) = LOWER(?)");
    params.push(state);
  }
  if (documentId) {
    conditions.push("document_id = ?");
    params.push(documentId);
  }
  if (source) {
    conditions.push("LOWER(source) = LOWER(?)");
    params.push(source);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(`SELECT * FROM upload_chunks ${where} ORDER BY created_at ASC`)
    .all(...params);
  return rows.map(rowToChunk);
}

/**
 * Insert an array of chunks in a single transaction. Skips duplicates by id.
 * @param {object[]} chunks
 */
async function insertChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return;

  const rows = chunks.map(chunkToRow);
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.query(
        `INSERT INTO upload_chunks (
          id, source, text, parsed_type, metadata, structured,
          county, state, chunk_index, chunk_count, row_index,
          document_id, original_file_name, original_mime_type, original_size,
          original_stored_filename, original_stored_path, original_stored_at,
          embedding, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(id) DO NOTHING`,
        [
          row.id,
          row.source,
          row.text,
          row.parsed_type,
          row.metadata,
          row.structured,
          row.county,
          row.state,
          row.chunk_index,
          row.chunk_count,
          row.row_index,
          row.document_id,
          row.original_file_name,
          row.original_mime_type,
          row.original_size,
          row.original_stored_filename,
          row.original_stored_path,
          row.original_stored_at,
          row.embedding,
          row.created_at,
        ],
      );
    }
  });
}

/**
 * Update the stored embedding for a single chunk.
 * @param {string} id
 * @param {number[]} embedding
 * @param {string} county
 */
async function updateChunkEmbedding(id, embedding, county) {
  const value = Array.isArray(embedding) ? JSON.stringify(embedding) : null;
  await db
    .prepare(
      "UPDATE upload_chunks SET embedding = ? WHERE id = ? AND LOWER(county) = LOWER(?)",
    )
    .run(value, id, county);
}

/**
 * Delete a single chunk by id, scoped to the given county.
 * @param {string} id
 * @param {string} county
 * @returns {number} rows deleted
 */
async function deleteChunksById(id, county) {
  const result = await db
    .prepare(
      "DELETE FROM upload_chunks WHERE id = ? AND LOWER(county) = LOWER(?)",
    )
    .run(id, county);
  return result.changes;
}

/**
 * Delete all chunks matching source + county.
 * @param {string} source
 * @param {string} county
 * @returns {number} rows deleted
 */
async function deleteChunksBySource(source, county) {
  const result = await db
    .prepare(
      "DELETE FROM upload_chunks WHERE LOWER(source) = LOWER(?) AND LOWER(county) = LOWER(?)",
    )
    .run(source, county);
  return result.changes;
}

/**
 * Return the ids of all chunks matching id or source within a county,
 * without deleting them. Used to collect Milvus ids before deletion.
 */
async function findChunkIds({ id, source, county }) {
  if (id) {
    const row = await db
      .prepare(
        "SELECT id FROM upload_chunks WHERE id = ? AND LOWER(county) = LOWER(?)",
      )
      .get(id, county);
    return row ? [row.id] : [];
  }
  if (source) {
    const rows = await db
      .prepare(
        "SELECT id FROM upload_chunks WHERE LOWER(source) = LOWER(?) AND LOWER(county) = LOWER(?)",
      )
      .all(source, county);
    return rows.map((r) => r.id);
  }
  return [];
}

module.exports = {
  readChunks,
  insertChunks,
  updateChunkEmbedding,
  deleteChunksById,
  deleteChunksBySource,
  findChunkIds,
};
