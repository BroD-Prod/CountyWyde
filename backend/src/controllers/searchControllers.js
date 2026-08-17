require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { embedText, cosineSimilarity } = require("../lib/embeddings");
const { searchByVector: milvusSearch } = require("../lib/vectorStore");
const { readChunks } = require("../lib/uploadStore");
const helperController = require("./helperController");
const { normalizeCounty, isRegisteredState } = require("../lib/countyRegistry");

let genAi = null;

function getGenAiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  if (!genAi) {
    genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  return genAi;
}

const MAX_JSON_BYTES = 1 * 1024 * 1024;
const RRF_K = 60;
const MAX_LEXICAL = 10;
const MAX_VECTOR = 10;
const MIN_CONFIDENCE_SCORE = 1 / (RRF_K + MAX_LEXICAL + 1);
const VECTOR_RRF_WEIGHT = 1.2;
const LEXICAL_RRF_WEIGHT = 0.45;
const MAX_EVIDENCE_CHUNKS = 8;
const MAX_EVIDENCE_PER_SOURCE = 3;

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

function getRecordTimestamp(record) {
  const candidates = [
    record?.createdAt,
    record?.originalStoredAt,
    record?.metadata?.createdAt,
    record?.metadata?.videoCreatedAt,
    record?.videoCreatedAt,
    record?.record?.createdAt,
    record?.record?.metadata?.videoCreatedAt,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  return null;
}

function getMostRecentTimestamp(records) {
  const timestamps = (Array.isArray(records) ? records : [])
    .map((record) => getRecordTimestamp(record))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return null;
  }

  return Math.max(...timestamps);
}

function getRecencyBoost(record, records = []) {
  const timestamp = getRecordTimestamp(record);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const newestTimestamp = getMostRecentTimestamp(records);
  if (!Number.isFinite(newestTimestamp)) {
    return 0;
  }

  const timestamps = (Array.isArray(records) ? records : [])
    .map((item) => getRecordTimestamp(item))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length <= 1) {
    return 0.35;
  }

  const oldestTimestamp = Math.min(...timestamps);
  const freshnessWindow = Math.max(1, newestTimestamp - oldestTimestamp);
  const ageFromNewest = newestTimestamp - timestamp;
  const normalizedAge = Math.min(1, ageFromNewest / freshnessWindow);
  return (1 - normalizedAge) * 0.85;
}

function rankByOverlap(records, prompt, max = 5) {
  const promptTokens = new Set(tokenize(prompt));

  return records
    .map((record) => {
      const recordTokens = tokenize(
        `${record.source || ""} ${record.text || ""}`
      );
      let score = 0;

      for (const token of recordTokens) {
        if (promptTokens.has(token)) {
          score += 1;
        }
      }

      return { record, score: score + getRecencyBoost(record, records) };
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
      score:
        cosineSimilarity(record.embedding, queryEmbedding) +
        getRecencyBoost(record, records),
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
      current.score += (1 / (RRF_K + rankIndex + 1)) * 0.5;
    }

    scores.set(record.id, current);
  };

  vectorMatches.forEach((entry, index) => upsert(entry, "vector", index));
  lexicalMatches.forEach((entry, index) => upsert(entry, "lexical", index));

  const allRecords = [...vectorMatches, ...lexicalMatches].map((entry) => entry.record);

  for (const item of scores.values()) {
    const recordTokens = new Set(
      tokenize(`${item.record.source || ""} ${item.record.text || ""}`)
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

    item.score += getRecencyBoost(item.record, allRecords);
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

async function rankVectorWithMilvus(records, queryEmbedding, county, state, max) {
  try {
    const hits = await milvusSearch(queryEmbedding, { county, state }, max);
    const recordMap = new Map(records.map((r) => [String(r.id), r]));
    return hits
      .map((hit) => ({ record: recordMap.get(hit.chunkId), score: hit.score }))
      .filter((item) => item.record !== undefined);
  } catch {
    return rankByVector(records, queryEmbedding, max);
  }
}

async function rankHybrid(records, prompt, max = 5, { county, state } = {}) {
  const lexicalMatches = rankByOverlap(records, prompt, MAX_LEXICAL * 2);

  let queryEmbedding = null;
  let vectorMatches = [];
  try {
    queryEmbedding = await embedPrompt(prompt);
    if (county && state) {
      vectorMatches = await rankVectorWithMilvus(
        records,
        queryEmbedding,
        county,
        state,
        MAX_VECTOR * 2
      );
    } else {
      vectorMatches = rankByVector(records, queryEmbedding, MAX_VECTOR * 2);
    }
  } catch {
    queryEmbedding = null;
  }

  if (!queryEmbedding) {
    return lexicalMatches.slice(0, max).map((entry, index) => ({
      record: entry.record,
      score: 1 / (RRF_K + index + 1) + getRecencyBoost(entry.record, records),
      vectorScore: 0,
      lexicalScore: entry.score,
      promptCoverage: entry.score,
    }));
  }

  const reranked = rerankMatches(vectorMatches, lexicalMatches, prompt, max);

  if (reranked.length > 0) {
    return reranked;
  }

  return lexicalMatches.slice(0, max).map((entry, index) => ({
    record: entry.record,
    score: 1 / (RRF_K + index + 1) + getRecencyBoost(entry.record, records),
    vectorScore: 0,
    lexicalScore: entry.score,
    promptCoverage: entry.score,
  }));
}

function selectTopChunksPerSource(
  matches,
  maxPerSource = MAX_EVIDENCE_PER_SOURCE,
  maxTotal = MAX_EVIDENCE_CHUNKS
) {
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
      originalFileName:
        String(record.originalFileName || record.source || "") || null,
      parsedType: record.parsedType || null,
      videoId: record.videoId || null,
      chunkIndex,
      chunkCount,
      text: String(record.text || ""),
      record,
    };
  });
}

function findPdfDocumentBySource(records, sourceName) {
  const normalizedSource = String(sourceName || "").trim().toLowerCase();
  if (!normalizedSource) {
    return null;
  }

  return (
    records.find(
      (item) =>
        item?.parsedType === "pdf" &&
        String(item?.source || "").trim().toLowerCase() === normalizedSource &&
        String(item?.documentId || "").trim() &&
        typeof item?.originalStoredPath === "string"
    ) || null
  );
}

function formatTranscriptTimestamp(seconds) {
  if (!Number.isFinite(Number(seconds))) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const minuteWithinHour = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minuteWithinHour).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function normalizeSegmentStartScale(segments) {
  const starts = segments
    .map((segment) => Number(segment?.start))
    .filter((start) => Number.isFinite(start));

  if (starts.length === 0) {
    return segments;
  }

  const divisibleByThousandCount = starts.filter(
    (start) => Number.isInteger(start) && Math.abs(start) % 1000 === 0
  ).length;
  const maxStart = Math.max(...starts);
  const avgStart = starts.reduce((sum, value) => sum + value, 0) / starts.length;
  const isLikelyMilliseconds =
    maxStart >= 1000 &&
    (divisibleByThousandCount / starts.length >= 0.25 ||
      maxStart > 24 * 60 * 60 ||
      avgStart > 2 * 60 * 60);

  if (!isLikelyMilliseconds) {
    return segments;
  }

  return segments.map((segment) => ({
    ...segment,
    start: Number.isFinite(Number(segment?.start))
      ? Number(segment.start) / 1000
      : segment.start,
  }));
}

function buildVideoTranscriptTimestampLink(item, answerText) {
  const record = item?.record || item;
  if (!record || String(record?.parsedType || "").toLowerCase() !== "whisper_transcript") {
    return null;
  }

  const structuredSegments = Array.isArray(record?.structured?.segments)
    ? record.structured.segments
    : [];
  const scaledSegments = normalizeSegmentStartScale(structuredSegments);
  const normalizedSegments = scaledSegments
    .filter(
      (segment) =>
        Number.isFinite(Number(segment?.start)) &&
        String(segment?.text || "").trim()
    )
    .map((segment) => ({
      start: Number(segment.start),
      text: String(segment.text || "").trim(),
    }));

  if (normalizedSegments.length === 0) {
    return null;
  }

  const answerTokens = new Set(
    tokenize(answerText).filter((token) => token.length > 2)
  );

  const scoredSegments = normalizedSegments
    .map((segment) => {
      const segmentTokens = tokenize(segment.text);
      let overlap = 0;
      for (const token of segmentTokens) {
        if (answerTokens.has(token)) {
          overlap += 1;
        }
      }

      return {
        ...segment,
        overlap,
      };
    })
    .sort((a, b) => {
      if (b.overlap !== a.overlap) {
        return b.overlap - a.overlap;
      }
      return a.start - b.start;
    });

  const topSegments = scoredSegments
    .slice(0, 3)
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({
      start: segment.start,
      text: segment.text,
    }));

  const primarySegment = scoredSegments[0] || topSegments[0];
  const startSeconds = Number(primarySegment?.start ?? null);
  if (!Number.isFinite(startSeconds)) {
    return null;
  }

  const videoId = String(record?.metadata?.videoId || item?.videoId || "").trim();

  return {
    timestamp: formatTranscriptTimestamp(startSeconds),
    timestampSeconds: Math.floor(startSeconds),
    transcriptSnippet: primarySegment?.text || null,
    transcriptSegments: topSegments,
    videoId: videoId || null,
  };
}

async function getSearch(req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({ message: "POST /search to query your county uploads" })
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
        JSON.stringify({ error: "No county is associated with your account" })
      );
      return;
    }

    if (!state) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "State is required" }));
      return;
    }

    if (!(await isRegisteredState(state))) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Please select a valid state" }));
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Missing GEMINI_API_KEY" }));
      return;
    }

    const countyUploads = await readChunks({ county, state });
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
        })
      );
      return;
    }

    const evidenceMatches = selectTopChunksPerSource(rankedMatches);
    const evidenceItems = buildEvidenceItems(evidenceMatches);

    const model = getGenAiClient().getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: `You are an expert assistant tasked with rewriting and summarizing source text into clean, professional, and completely original phrasing.

    CRITICAL RULES:
    1. STRICT PARAPHRASING: You must completely rephrase the information using your own words, sentence structures, and vocabulary. Never copy blocks of text directly from the source. 
    2. FACTUAL RIGOR: Remain 100% faithful to the facts in the provided context. Do not invent details or bring in outside knowledge.
    3. FALLBACK: If the context does not contain information to answer the prompt, reply exactly: "I do not have that information."
    4. STYLE: Present the summary in a professional, objective tone.`,
      generationConfig: {
        temperature: 0.4,
      },
    });

    const contextText = evidenceItems
      .map((item) => `[Source: ${item.source}]\n${item.text}`)
      .join("\n\n");
    const groundedPrompt = `Context:\n${contextText}\n\nQuestion: ${prompt}`;

    const result = await model.generateContent(groundedPrompt);
    const resultText = result.response.text();

    const responseSources = evidenceItems.map((item, index) => {
      const fallback =
        item.documentId
          ? item
          : findPdfDocumentBySource(countyUploads, item.source);
      const videoTimestampLink =
        index === 0
          ? buildVideoTranscriptTimestampLink(item, resultText)
          : null;

      return {
        id: item.chunkId,
        source: item.source,
        documentId: fallback?.documentId || item.documentId || null,
        originalFileName:
          fallback?.originalFileName ||
          item.originalFileName ||
          item.source ||
          null,
        parsedType: item.parsedType || null,
        ...(videoTimestampLink
          ? {
            timestamp: videoTimestampLink.timestamp,
            timestampSeconds: videoTimestampLink.timestampSeconds,
            transcriptSnippet: videoTimestampLink.transcriptSnippet,
            transcriptSegments: videoTimestampLink.transcriptSegments,
            videoId: videoTimestampLink.videoId,
          }
          : {}),
      };
    });

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        result: resultText,
        sources: responseSources,
      })
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.end(JSON.stringify({ error: error.message || "Bad Request" }));
  }
}

module.exports = {
  getSearch,
  postSearch,
  buildVideoTranscriptTimestampLink,
  findPdfDocumentBySource,
};