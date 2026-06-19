/**
 * vectorStore.js
 *
 * Thin abstraction over Milvus for insert / ANN search / delete.
 * All callers should use this module rather than touching milvusClient directly.
 */

const { getClient, ensureCollection, COLLECTION_NAME } = require("./milvusClient");

const DEFAULT_TOP_K = 10;
const DEFAULT_EF = 64;

/**
 * Upsert a single chunk's vector into Milvus.
 *
 * @param {{
 *   chunkId: string,
 *   county: string,
 *   state: string,
 *   source: string,
 *   embedding: number[]
 * }} chunk
 * @returns {Promise<void>}
 */
async function upsertChunk({ chunkId, county, state, source, embedding }) {
    if (!Array.isArray(embedding) || embedding.length === 0) {
        return;
    }

    await ensureCollection();
    const milvus = getClient();

    // Milvus upsert will insert-or-replace based on primary key (chunk_id)
    await milvus.upsert({
        collection_name: COLLECTION_NAME,
        data: [
            {
                chunk_id: String(chunkId),
                county: String(county || "").toLowerCase(),
                state: String(state || "").toUpperCase(),
                source: String(source || "").slice(0, 512),
                embedding,
            },
        ],
    });
}

/**
 * Upsert many chunks in a single batched call (more efficient for backfill).
 *
 * @param {Array<{ chunkId: string, county: string, state: string, source: string, embedding: number[] }>} chunks
 * @param {number} [batchSize=200]
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
async function upsertChunks(chunks, batchSize = 200) {
    const valid = chunks.filter(
        (c) => Array.isArray(c.embedding) && c.embedding.length > 0,
    );
    if (valid.length === 0) {
        return { inserted: 0, skipped: chunks.length };
    }

    await ensureCollection();
    const milvus = getClient();

    let inserted = 0;

    for (let i = 0; i < valid.length; i += batchSize) {
        const batch = valid.slice(i, i + batchSize).map((c) => ({
            chunk_id: String(c.chunkId),
            county: String(c.county || "").toLowerCase(),
            state: String(c.state || "").toUpperCase(),
            source: String(c.source || "").slice(0, 512),
            embedding: c.embedding,
        }));

        await milvus.upsert({ collection_name: COLLECTION_NAME, data: batch });
        inserted += batch.length;
    }

    return { inserted, skipped: chunks.length - valid.length };
}

/**
 * ANN vector search filtered by county and state.
 *
 * @param {number[]} queryEmbedding
 * @param {{ county: string, state: string }} filter
 * @param {number} [topK]
 * @returns {Promise<Array<{ chunkId: string, score: number, source: string }>>}
 */
async function searchByVector(queryEmbedding, { county, state }, topK = DEFAULT_TOP_K) {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
        return [];
    }

    await ensureCollection();
    const milvus = getClient();

    const normalizedCounty = String(county || "").toLowerCase();
    const normalizedState = String(state || "").toUpperCase();

    // Build the boolean expression filter
    const filterParts = [];
    if (normalizedCounty) {
        filterParts.push(`county == "${normalizedCounty.replace(/"/g, '\\"')}"`);
    }
    if (normalizedState) {
        filterParts.push(`state == "${normalizedState.replace(/"/g, '\\"')}"`);
    }

    const expr = filterParts.length > 0 ? filterParts.join(" && ") : "";

    const response = await milvus.search({
        collection_name: COLLECTION_NAME,
        data: [queryEmbedding],
        anns_field: "embedding",
        limit: topK,
        filter: expr || undefined,
        output_fields: ["chunk_id", "source"],
        params: { ef: DEFAULT_EF },
    });

    const hits = response?.results ?? [];

    return hits.map((hit) => ({
        chunkId: hit.chunk_id,
        score: hit.score,
        source: hit.source,
    }));
}

/**
 * Delete vectors for a list of chunk IDs.
 *
 * @param {string[]} chunkIds
 * @returns {Promise<void>}
 */
async function deleteChunks(chunkIds) {
    if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
        return;
    }

    await ensureCollection();
    const milvus = getClient();

    const ids = chunkIds.map((id) => `"${String(id).replace(/"/g, '\\"')}"`);
    await milvus.delete({
        collection_name: COLLECTION_NAME,
        filter: `chunk_id in [${ids.join(", ")}]`,
    });
}

module.exports = {
    upsertChunk,
    upsertChunks,
    searchByVector,
    deleteChunks,
};
