const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_EMBEDDING_MODELS = [
  "text-embedding-004",
  "embedding-001",
  "gemini-embedding-001",
];
const EMBEDDING_MODEL =
  (process.env.EMBEDDING_MODEL || "").trim() || DEFAULT_EMBEDDING_MODELS[0];
const EMBEDDING_MAX_CHARS = 8000;

let cachedClient = null;
const modelCache = new Map();
let activeEmbeddingModel = EMBEDDING_MODEL;

function getEmbeddingClient() {
  if (cachedClient) {
    return cachedClient;
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY for embeddings");
  }

  cachedClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return cachedClient;
}

function getEmbeddingModel(modelName) {
  if (modelCache.has(modelName)) {
    return modelCache.get(modelName);
  }

  const model = getEmbeddingClient().getGenerativeModel({ model: modelName });
  modelCache.set(modelName, model);
  return model;
}

function getEmbeddingModelCandidates() {
  const configured = (process.env.EMBEDDING_MODEL || "").trim();
  const ordered = [];

  if (activeEmbeddingModel) {
    ordered.push(activeEmbeddingModel);
  }

  if (configured) {
    ordered.push(configured);
  }

  for (const fallback of DEFAULT_EMBEDDING_MODELS) {
    ordered.push(fallback);
  }

  return [...new Set(ordered)];
}

function isUnavailableModelError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("unknown model")
  );
}

async function embedText(text, maxChars = EMBEDDING_MAX_CHARS) {
  const input = String(text || "").slice(0, maxChars);
  if (!input.trim()) {
    return null;
  }

  const attemptErrors = [];

  for (const modelName of getEmbeddingModelCandidates()) {
    const model = getEmbeddingModel(modelName);

    try {
      const response = await model.embedContent(input);
      const values = response?.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("Embedding provider returned an empty vector");
      }

      activeEmbeddingModel = modelName;
      return values;
    } catch (error) {
      const message = error?.message || "Unknown embedding error";
      attemptErrors.push(`${modelName}: ${message}`);

      if (isUnavailableModelError(error)) {
        continue;
      }

      throw new Error(`Embedding request failed (${modelName}): ${message}`);
    }
  }

  throw new Error(
    `Embedding request failed. Tried models: ${getEmbeddingModelCandidates().join(", ")}. Errors: ${attemptErrors.join(" | ")}`,
  );
}

async function mapWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const queue = [...items];

  const runners = Array.from(
    { length: Math.min(safeConcurrency, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await worker(item);
        }
      }
    },
  );

  await Promise.all(runners);
}

async function attachEmbeddings(records, options = {}) {
  const {
    textField = "text",
    embeddingField = "embedding",
    concurrency = 4,
    maxChars = EMBEDDING_MAX_CHARS,
  } = options;

  await mapWithConcurrency(records, concurrency, async (record) => {
    record[embeddingField] = await embedText(record[textField], maxChars);
  });

  return records;
}

function cosineSimilarity(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length === 0 ||
    b.length === 0 ||
    a.length !== b.length
  ) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return -1;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_MAX_CHARS,
  embedText,
  mapWithConcurrency,
  attachEmbeddings,
  cosineSimilarity,
};
