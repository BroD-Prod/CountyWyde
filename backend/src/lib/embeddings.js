const { GoogleGenerativeAI } = require("@google/generative-ai");

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_MAX_CHARS = 8000;

let cachedModel = null;

function getEmbeddingModel() {
  if (cachedModel) {
    return cachedModel;
  }

  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  cachedModel = client.getGenerativeModel({ model: EMBEDDING_MODEL });
  return cachedModel;
}

async function embedText(text, maxChars = EMBEDDING_MAX_CHARS) {
  const model = getEmbeddingModel();
  if (!model) {
    return null;
  }

  const input = String(text || "").slice(0, maxChars);
  if (!input.trim()) {
    return null;
  }

  try {
    const response = await model.embedContent(input);
    const values = response?.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
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
