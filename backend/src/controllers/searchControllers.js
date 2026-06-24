require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { embedText, cosineSimilarity } = require("../lib/embeddings");
const { searchByVector: milvusSearch } = require("../lib/vectorStore");
const { readChunks } = require("../lib/uploadStore");
const helperController = require("./helperController");
const { normalizeCounty, isRegisteredState } = require("../lib/countyRegistry");

const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const RRF_K = 60;
const MAX_LEXICAL = 10;
const MAX_VECTOR = 10;
const MIN_CONFIDENCE_SCORE = 1 / (RRF_K + MAX_LEXICAL + 1);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => {
      if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
      }
      if (token.length > 3 && token.endsWith("s")) {
        return token.slice(0, -1);
      }
      return token;
    })
    .filter(Boolean);
}

function getSupportingSources(matches, answerText, fallback = 1) {
  const answer = String(answerText || "").trim();
  if (!answer) {
    return matches.slice(0, fallback);
  }

  const answerTokens = Array.from(
    new Set(tokenize(answer).filter((token) => token.length > 2)),
  );

  if (answerTokens.length === 0) {
    return matches.slice(0, fallback);
  }

  const tokenDocumentFrequency = new Map();

  for (const record of matches) {
    const tokenSet = new Set(tokenize(String(record.text || "")));
    for (const token of answerTokens) {
      if (tokenSet.has(token)) {
        tokenDocumentFrequency.set(
          token,
          (tokenDocumentFrequency.get(token) || 0) + 1,
        );
      }
    }
  }

  const totalDocs = Math.max(matches.length, 1);
  const scored = matches
    .map((record) => {
      const tokenSet = new Set(tokenize(String(record.text || "")));
      let weightedOverlap = 0;
      let overlapCount = 0;

      for (const token of answerTokens) {
        if (!tokenSet.has(token)) {
          continue;
        }

        overlapCount += 1;
        const df = tokenDocumentFrequency.get(token) || 0;
        const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
        weightedOverlap += idf;
      }

      return {
        record,
        weightedOverlap,
        overlapCount,
      };
    })
    .filter((item) => item.overlapCount > 0)
    .sort((a, b) => {
      if (b.weightedOverlap !== a.weightedOverlap) {
        return b.weightedOverlap - a.weightedOverlap;
      }
      return b.overlapCount - a.overlapCount;
    });

  if (scored.length === 0) {
    return matches.slice(0, fallback);
  }

  return [scored[0].record];
}

function rankByOverlap(records, prompt, max = 5) {
  const promptTokens = new Set(tokenize(prompt));

  return records
    .map((record) => {
      const recordTokens = tokenize(
        `${record.source || ""} ${record.text || ""}`,
      );
      let score = 0;

      for (const token of recordTokens) {
        if (promptTokens.has(token)) {
          score += 1;
        }
      }

      return { record, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

async function embedPrompt(prompt) {
  return embedText(prompt);
}

function rankByVector(records, queryEmbedding, max = 5) {
  if (!queryEmbedding) {
    return [];
  }

  return records
    .map((record) => ({
      record,
      score: cosineSimilarity(record.embedding, queryEmbedding),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

function fuseWithRrf(lexicalMatches, vectorMatches, max = 5) {
  const scores = new Map();

  lexicalMatches.forEach((entry, index) => {
    const record = entry.record;
    const current = scores.get(record.id) || { record, score: 0 };
    current.score += 1 / (RRF_K + index + 1);
    scores.set(record.id, current);
  });

  vectorMatches.forEach((entry, index) => {
    const record = entry.record;
    const current = scores.get(record.id) || { record, score: 0 };
    current.score += 1 / (RRF_K + index + 1);
    scores.set(record.id, current);
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

async function rankVectorWithMilvus(
  records,
  queryEmbedding,
  county,
  state,
  max,
) {
  try {
    const hits = await milvusSearch(queryEmbedding, { county, state }, max);
    const recordMap = new Map(records.map((r) => [String(r.id), r]));
    return hits
      .map((hit) => ({ record: recordMap.get(hit.chunkId), score: hit.score }))
      .filter((item) => item.record !== undefined);
  } catch {
    // Graceful degradation: fall back to brute-force cosine similarity
    return rankByVector(records, queryEmbedding, max);
  }
}

async function rankHybrid(records, prompt, max = 5, { county, state } = {}) {
  const lexicalMatches = rankByOverlap(records, prompt, MAX_LEXICAL);

  let vectorMatches = [];
  try {
    const queryEmbedding = await embedPrompt(prompt);
    if (county && state) {
      vectorMatches = await rankVectorWithMilvus(
        records,
        queryEmbedding,
        county,
        state,
        MAX_VECTOR,
      );
    } else {
      vectorMatches = rankByVector(records, queryEmbedding, MAX_VECTOR);
    }
  } catch {
    vectorMatches = [];
  }

  if (vectorMatches.length === 0) {
    return lexicalMatches.slice(0, max).map((entry, index) => ({
      record: entry.record,
      score: 1 / (RRF_K + index + 1),
    }));
  }

  return fuseWithRrf(lexicalMatches, vectorMatches, max);
}

function extractRelevantLines(matches, prompt, maxLines = 8) {
  const promptTokens = tokenize(prompt).filter((token) => token.length > 2);
  if (promptTokens.length === 0) {
    return "";
  }
  const scored = [];

  for (const match of matches) {
    const lines = String(match.text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineTokenSet = new Set(tokenize(line));
      let score = 0;

      for (const token of promptTokens) {
        if (lineTokenSet.has(token)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ line, score, index: i, lines });
      }
    }
  }

  if (scored.length === 0) {
    return "";
  }

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  const seen = new Set();

  for (const item of scored) {
    if (selected.length >= maxLines) {
      break;
    }

    const candidates = [item.index - 1, item.index, item.index + 1]
      .filter((idx) => idx >= 0 && idx < item.lines.length)
      .map((idx) => item.lines[idx]);

    for (const candidate of candidates) {
      if (!seen.has(candidate) && selected.length < maxLines) {
        seen.add(candidate);
        selected.push(candidate);
      }
    }
  }

  return selected.join("\n");
}

function dedupeMatchesBySource(matches) {
  const seenSources = new Set();
  const deduped = [];

  for (const match of matches) {
    const sourceKey = String(match?.source || "")
      .trim()
      .toLowerCase();
    if (!sourceKey || seenSources.has(sourceKey)) {
      continue;
    }

    seenSources.add(sourceKey);
    deduped.push(match);
  }

  return deduped;
}

function findPdfDocumentBySource(records, sourceName) {
  const normalizedSource = String(sourceName || "")
    .trim()
    .toLowerCase();
  if (!normalizedSource) {
    return null;
  }

  return (
    records.find(
      (item) =>
        item?.parsedType === "pdf" &&
        String(item?.source || "")
          .trim()
          .toLowerCase() === normalizedSource &&
        String(item?.documentId || "").trim() &&
        typeof item?.originalStoredPath === "string",
    ) || null
  );
}

async function getSearch(req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({ message: "POST /search to query your county uploads" }),
  );
}

async function postSearch(req, res) {
  try {
    const parsed = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
    const prompt = parsed.prompt;
    const county = normalizeCounty(parsed.county);
    const state = String(parsed.state || "").trim();

    if (!prompt) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Prompt is required" }));
      return;
    }

    if (!county) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ error: "No county is associated with your account" }),
      );
      return;
    }

    if (!state) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "State is required" }));
      return;
    }

    if (!isRegisteredState(state)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Please select a valid state" }));
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Missing GEMINI_API_KEY" }));
      return;
    }

    const countyUploads = readChunks({ county, state });
    const rankedMatches = await rankHybrid(countyUploads, prompt, MAX_VECTOR, {
      county,
      state,
    });

    if (
      rankedMatches.length === 0 ||
      rankedMatches[0].score < MIN_CONFIDENCE_SCORE
    ) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          result: "I do not have that information.",
          sources: [],
        }),
      );
      return;
    }

    const matches = rankedMatches.map((item) => item.record);
    const contextMatches = dedupeMatchesBySource(matches);

    const context = contextMatches
      .map((item, index) => `[${index + 1}] (${item.source}) ${item.text}`)
      .join("\n\n");

    const model = genAi.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: `You are an expert assistant tasked with rewriting and summarizing source text into clean, professional, and completely original phrasing.

    CRITICAL RULES:
    1. STRICT PARAPHRASING: You must completely rephrase the information using your own words, sentence structures, and vocabulary. Never copy blocks of text, distinct clauses, or unique sentence layouts directly from the source. 
    2. FACTUAL RIGOR: While you must completely change the wording, you must remain 100% faithful to the facts in the provided context. Do not invent details, extrapolate, or bring in outside knowledge.
    3. FALLBACK: If the provided context does not contain information to answer the prompt, reply exactly: "I do not have that information."
    4. STYLE: Present the summary in a professional, objective tone. Use clean bullet points or concise paragraphs rather than mimicking the conversational style of a transcript.`,
      generationConfig: {
        temperature: 0.4,
      },
    });

    const groundedPrompt = `Context:\n${context}\n\nQuestion:\n${prompt}`;
    const result = await model.generateContent(groundedPrompt);
    let text = result.response.text();

    const sources = /^i do not have that information\.?$/i.test(
      String(text).trim(),
    )
      ? []
      : getSupportingSources(contextMatches, text);

    res.statusCode = 200;
    const responseSources = sources.map((item) => {
      const fallback =
        item.documentId && item.originalStoredPath
          ? item
          : findPdfDocumentBySource(countyUploads, item.source);

      return {
        id: item.id,
        source: item.source,
        documentId: fallback?.documentId || item.documentId || null,
        originalFileName:
          fallback?.originalFileName ||
          item.originalFileName ||
          item.source ||
          null,
      };
    });

    res.end(
      JSON.stringify({
        result: text,
        sources: responseSources,
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.end(JSON.stringify({ error: error.message || "Bad Request" }));
  }
}

module.exports = {
  getSearch,
  postSearch,
};
