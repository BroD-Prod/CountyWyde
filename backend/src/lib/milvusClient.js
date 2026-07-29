const { MilvusClient, DataType } = require("@zilliz/milvus2-sdk-node");

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || "localhost:19530";
const COLLECTION_NAME = "county_chunks";
const MILVUS_ENABLED =
  String(process.env.MILVUS_ENABLED || "false").toLowerCase() === "true";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "3072");

let client = null;
let collectionReady = false;
let milvusUnavailableLogged = false;

function isMilvusEnabled() {
  return MILVUS_ENABLED;
}

function logMilvusUnavailableOnce(message) {
  if (milvusUnavailableLogged) {
    return;
  }

  milvusUnavailableLogged = true;
  console.warn(`[milvus] disabled: ${message}`);
}

function getClient() {
  if (!MILVUS_ENABLED) {
    return null;
  }

  if (!client) {
    client = new MilvusClient({ address: MILVUS_ADDRESS });
  }
  return client;
}

const COLLECTION_SCHEMA = {
  collection_name: COLLECTION_NAME,
  fields: [
    {
      name: "chunk_id",
      data_type: DataType.VarChar,
      max_length: 128,
      is_primary_key: true,
      auto_id: false,
      description: "Chunk string ID from uploads.json or SQLite",
    },
    {
      name: "county",
      data_type: DataType.VarChar,
      max_length: 255,
      description: "Normalized county name",
    },
    {
      name: "state",
      data_type: DataType.VarChar,
      max_length: 10,
      description: "State abbreviation",
    },
    {
      name: "source",
      data_type: DataType.VarChar,
      max_length: 512,
      description: "Original source filename",
    },
    {
      name: "embedding",
      data_type: DataType.FloatVector,
      dim: EMBEDDING_DIM,
      description: "Gemini text-embedding-004 vector",
    },
  ],
};

const HNSW_INDEX = {
  collection_name: COLLECTION_NAME,
  field_name: "embedding",
  index_name: "embedding_hnsw_idx",
  index_type: "HNSW",
  metric_type: "COSINE",
  params: { M: 16, efConstruction: 200 },
};

async function ensureCollection() {
  if (!MILVUS_ENABLED) {
    return false;
  }

  if (collectionReady) {
    return true;
  }

  const milvus = getClient();
  if (!milvus) {
    return false;
  }

  try {
    const exists = await milvus.hasCollection({
      collection_name: COLLECTION_NAME,
    });

    if (!exists.value) {
      await milvus.createCollection(COLLECTION_SCHEMA);
      await milvus.createIndex(HNSW_INDEX);

      // Scalar indexes for filter performance on county/state
      await milvus.createIndex({
        collection_name: COLLECTION_NAME,
        field_name: "county",
        index_name: "county_scalar_idx",
        index_type: "Trie",
      });
      await milvus.createIndex({
        collection_name: COLLECTION_NAME,
        field_name: "state",
        index_name: "state_scalar_idx",
        index_type: "Trie",
      });
    }

    await milvus.loadCollection({ collection_name: COLLECTION_NAME });
    collectionReady = true;
    return true;
  } catch (error) {
    logMilvusUnavailableOnce(error?.message || "connection failed");
    return false;
  }
}

module.exports = {
  COLLECTION_NAME,
  EMBEDDING_DIM,
  MILVUS_ENABLED,
  isMilvusEnabled,
  getClient,
  ensureCollection,
};
