require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { attachEmbeddings, embedText, cosineSimilarity } = require("../lib/embeddings");
const { readUploads, writeUploads } = require("../lib/uploadStore");
const helperController = require("./helperController");
const { normalizeCounty, isRegisteredState } = require("../lib/countyRegistry");

const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const RRF_K = 60;
const MAX_LEXICAL = 10;
const MAX_VECTOR = 10;
const MIN_CONFIDENCE_SCORE = 1 / (RRF_K + MAX_LEXICAL + 1);
const VECTOR_RRF_WEIGHT = 1.2;
const LEXICAL_RRF_WEIGHT = 0.45;
const MAX_EVIDENCE_CHUNKS = 8;
const MAX_EVIDENCE_PER_SOURCE = 3;
const CLAIM_SUPPORT_THRESHOLD = 0.35;

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

function rankByOverlap(records, prompt, max = 5) {
  const promptTokens = new Set(tokenize(prompt));

  return records
    .map((record) => {
      const recordTokens = tokenize(`${record.source || ""} ${record.text || ""}`);
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

function rerankMatches(vectorMatches, lexicalMatches, prompt, max = 5) {
  const promptTokens = tokenize(prompt).filter((token) => token.length > 2);
  const scores = new Map();

  const upsert = (entry, kind, rankIndex) => {
    const record = entry.record;
    const current = scores.get(record.id) || {
      record,
      score: 0,
      vectorScore: 0,
      lexicalScore: 0,
      promptCoverage: 0,
    };

    if (kind === "vector") {
      current.vectorScore = Math.max(current.vectorScore, entry.score || 0);
      current.score += Math.max(entry.score || 0, 0) * VECTOR_RRF_WEIGHT;
      current.score += 1 / (RRF_K + rankIndex + 1);
    } else {
      current.lexicalScore = Math.max(current.lexicalScore, entry.score || 0);
      current.score += Math.max(entry.score || 0, 0) * LEXICAL_RRF_WEIGHT;
      current.score += 1 / (RRF_K + rankIndex + 1) * 0.5;
    }

    scores.set(record.id, current);
  };

  vectorMatches.forEach((entry, index) => upsert(entry, "vector", index));
  lexicalMatches.forEach((entry, index) => upsert(entry, "lexical", index));

  for (const item of scores.values()) {
    const recordTokens = new Set(
      tokenize(`${item.record.source || ""} ${item.record.text || ""}`),
    );
    let overlap = 0;

    for (const token of promptTokens) {
      if (recordTokens.has(token)) {
        overlap += 1;
      }
    }

    item.promptCoverage = overlap;
    if (promptTokens.length > 0) {
      item.score += (overlap / promptTokens.length) * 0.75;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.promptCoverage !== a.promptCoverage) {
        return b.promptCoverage - a.promptCoverage;
      }
      return (b.vectorScore || 0) - (a.vectorScore || 0);
    })
    .slice(0, max);
}

async function rankHybrid(records, prompt, max = MAX_EVIDENCE_CHUNKS) {
  let queryEmbedding = null;
  try {
    queryEmbedding = await embedPrompt(prompt);
  } catch {
    queryEmbedding = null;
  }

  const lexicalMatches = rankByOverlap(records, prompt, MAX_LEXICAL * 2);

  if (!queryEmbedding) {
    return lexicalMatches.slice(0, max).map((entry, index) => ({
      record: entry.record,
      score: 1 / (RRF_K + index + 1),
      vectorScore: 0,
      lexicalScore: entry.score,
      promptCoverage: entry.score,
    }));
  }

  const vectorMatches = rankByVector(records, queryEmbedding, MAX_VECTOR * 2);
  const reranked = rerankMatches(vectorMatches, lexicalMatches, prompt, max);

  if (reranked.length > 0) {
    return reranked;
  }

  return lexicalMatches.slice(0, max).map((entry, index) => ({
    record: entry.record,
    score: 1 / (RRF_K + index + 1),
    vectorScore: 0,
    lexicalScore: entry.score,
    promptCoverage: entry.score,
  }));
}

function selectTopChunksPerSource(matches, maxPerSource = MAX_EVIDENCE_PER_SOURCE, maxTotal = MAX_EVIDENCE_CHUNKS) {
  const selected = [];
  const countsBySource = new Map();

  for (const match of matches) {
    const record = match.record || match;
    const sourceKey = String(record?.source || "").trim().toLowerCase();
    if (!sourceKey) {
      continue;
    }

    const currentCount = countsBySource.get(sourceKey) || 0;
    if (currentCount >= maxPerSource) {
      continue;
    }

    countsBySource.set(sourceKey, currentCount + 1);
    selected.push(match);

    if (selected.length >= maxTotal) {
      break;
    }
  }

  return selected;
}

function getCountyUploadsForSearch(uploads, county, state) {
  const countyCandidates = uploads.filter(
    (item) => normalizeCounty(item.county) === county,
  );
  const hasStateAwareRecords = countyCandidates.some((item) =>
    Boolean(String(item.state || "").trim()),
  );

  if (!hasStateAwareRecords) {
    return countyCandidates;
  }

  const normalizedState = String(state || "").trim().toLowerCase();
  return countyCandidates.filter((item) => {
    const itemState = String(item.state || "").trim().toLowerCase();
    return itemState === normalizedState;
  });
}

function normalizeCitationIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0);
  }

  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? [numeric] : [];
}

function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildEvidenceItems(matches) {
  return matches.map((match, index) => {
    const record = match.record || match;
    const chunkIndex = Number.isFinite(Number(record.chunkIndex))
      ? Number(record.chunkIndex)
      : null;
    const chunkCount = Number.isFinite(Number(record.chunkCount))
      ? Number(record.chunkCount)
      : null;

    return {
      citationId: index + 1,
      score: Number(match.score || 0),
      source: String(record.source || "Unknown source"),
      chunkId: String(record.id || ""),
      documentId: String(record.documentId || "") || null,
      originalFileName: String(record.originalFileName || record.source || "") || null,
      chunkIndex,
      chunkCount,
      text: String(record.text || ""),
      record,
    };
  });
}

function extractRelevantLines(matches, prompt, maxLines = 8) {
  const promptTokens = tokenize(prompt).filter((token) => token.length > 2);
  if (promptTokens.length === 0) {
    return "";
  }

  const scoredLines = [];

  for (const match of matches) {
    const lines = String(match.text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    lines.forEach((line, index) => {
      const lineTokens = new Set(tokenize(line));
      let score = 0;

      for (const token of promptTokens) {
        if (lineTokens.has(token)) {
          score += 1;
        }
      }

      if (score > 0) {
        scoredLines.push({ line, score, index, lines });
      }
    });
  }

  if (scoredLines.length === 0) {
    return "";
  }

  scoredLines.sort((a, b) => b.score - a.score);

  const selected = [];
  const seen = new Set();

  for (const item of scoredLines) {
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

    const uploads = await readUploads();
    const countyUploads = getCountyUploadsForSearch(uploads, county, state);
    const { uploads: hydratedUploads, changed } = await backfillMissingEmbeddings(
      uploads,
      countyUploads,
    );

    if (changed) {
      await writeUploads(hydratedUploads);
    }

    const countyUploadsForSearch = getCountyUploadsForSearch(
      hydratedUploads,
      county,
      state,
    );
    const rankedMatches = await rankHybrid(countyUploadsForSearch, prompt);

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

    const evidenceMatches = selectTopChunksPerSource(rankedMatches);
    const evidenceItems = buildEvidenceItems(evidenceMatches);

    const model = genAi.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You must answer using only the provided evidence. Return JSON only.",
      generationConfig: {
        temperature: 0.2,
      },
    });

    const groundedPrompt = buildStructuredPrompt(prompt, evidenceItems);
    const result = await model.generateContent(groundedPrompt);
    const rawText = result.response.text();
    const structuredResponse = extractJsonPayload(rawText) || {
      answer: String(rawText || "").trim(),
      claims: [],
      uncertainties: [],
    };

    const validation = validateStructuredClaims(structuredResponse, evidenceItems);
    const finalAnswer = buildFinalAnswer(
      structuredResponse,
      validation.validatedClaims,
    );
    const fallbackAnswer = /^i do not have that information\.?$/i.test(
      String(finalAnswer).trim(),
    )
      ? extractRelevantLines(
        evidenceItems.map((item) => ({ text: item.text })),
        prompt,
      ) || "I do not have that information."
      : finalAnswer;

    const responseSources = buildResponseSources(
      evidenceItems,
      validation.validatedClaims,
    );

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        result: fallbackAnswer,
        sources: responseSources,
        evidence: evidenceItems.map((item) => ({
          citationId: item.citationId,
          source: item.source,
          documentId: item.documentId,
          originalFileName: item.originalFileName,
          chunkId: item.chunkId,
          chunkIndex: item.chunkIndex,
          chunkCount: item.chunkCount,
          score: item.score,
        })),
        claims: validation.validatedClaims,
        unsupportedClaims: validation.unsupportedClaims,
        uncertainties: Array.isArray(structuredResponse.uncertainties)
          ? structuredResponse.uncertainties
          : [],
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.end(JSON.stringify({ error: error.message || "Bad Request" }));
  }
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

    const uploads = await readUploads();
    const countyUploads = getCountyUploadsForSearch(uploads, county, state);
    const { uploads: hydratedUploads, changed } = await backfillMissingEmbeddings(
      uploads,
      countyUploads,
    );
    if (changed) {
      await writeUploads(hydratedUploads);
    }
    const countyUploadsForSearch = getCountyUploadsForSearch(
      hydratedUploads,
      county,
      state,
    );
    const rankedMatches = await rankHybrid(countyUploadsForSearch, prompt);

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

    const evidenceMatches = selectTopChunksPerSource(rankedMatches);
    const evidenceItems = buildEvidenceItems(evidenceMatches);

    const model = genAi.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You must answer using only the provided evidence. Return JSON only.",
      generationConfig: {
        temperature: 0.2,
      },
    });

    const groundedPrompt = buildStructuredPrompt(prompt, evidenceItems);
    const result = await model.generateContent(groundedPrompt);
    const rawText = result.response.text();
    const structuredResponse = extractJsonPayload(rawText) || {
      answer: String(rawText || "").trim(),
      claims: [],
      uncertainties: [],
    };

    const validation = validateStructuredClaims(structuredResponse, evidenceItems);
    const finalAnswer = buildFinalAnswer(structuredResponse, validation.validatedClaims);
    const fallbackAnswer = /^i do not have that information\.?$/i.test(String(finalAnswer).trim())
      ? extractRelevantLines(
        evidenceItems.map((item) => ({ text: item.text })),
        prompt,
      ) || "I do not have that information."
      : finalAnswer;

    const responseSources = buildResponseSources(evidenceItems, validation.validatedClaims);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        result: fallbackAnswer,
        sources: responseSources,
        evidence: evidenceItems.map((item) => ({
          citationId: item.citationId,
          source: item.source,
          documentId: item.documentId,
          originalFileName: item.originalFileName,
          chunkId: item.chunkId,
          chunkIndex: item.chunkIndex,
          chunkCount: item.chunkCount,
          score: item.score,
        })),
        claims: validation.validatedClaims,
        unsupportedClaims: validation.unsupportedClaims,
        uncertainties: Array.isArray(structuredResponse.uncertainties)
          ? structuredResponse.uncertainties
          : [],
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
