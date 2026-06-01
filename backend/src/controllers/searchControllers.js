require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { embedText, cosineSimilarity } = require('../lib/embeddings');
const { readUploads } = require('../lib/uploadStore');
const helperController = require('./helperController');
const { normalizeCounty, isRegisteredState } = require('../lib/countyRegistry');

const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const RRF_K = 60;
const MAX_LEXICAL = 10;
const MAX_VECTOR = 10;
const MIN_CONFIDENCE_SCORE = 1 / (RRF_K + MAX_LEXICAL + 1);

function tokenize(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function getSupportingSources(matches, answerText, fallback = 1) {
    const answer = String(answerText || '').trim();
    if (!answer) {
        return matches.slice(0, fallback);
    }

    const answerTokens = Array.from(
        new Set(tokenize(answer).filter((token) => token.length > 2))
    );

    if (answerTokens.length === 0) {
        return matches.slice(0, fallback);
    }

    const tokenDocumentFrequency = new Map();

    for (const record of matches) {
        const tokenSet = new Set(tokenize(String(record.text || '')));
        for (const token of answerTokens) {
            if (tokenSet.has(token)) {
                tokenDocumentFrequency.set(token, (tokenDocumentFrequency.get(token) || 0) + 1);
            }
        }
    }

    const totalDocs = Math.max(matches.length, 1);
    const scored = matches
        .map((record) => {
            const tokenSet = new Set(tokenize(String(record.text || '')));
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
            const recordTokens = tokenize(record.text);
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

async function rankHybrid(records, prompt, max = 5) {
    const lexicalMatches = rankByOverlap(records, prompt, MAX_LEXICAL);

    let vectorMatches = [];
    try {
        const queryEmbedding = await embedPrompt(prompt);
        vectorMatches = rankByVector(records, queryEmbedding, MAX_VECTOR);
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
        return '';
    }
    const scored = [];

    for (const match of matches) {
        const lines = String(match.text || '')
            .split('\n')
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
        return '';
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

    return selected.join('\n');
}

async function getSearch(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'POST /search to query your county uploads' }));
}

async function postSearch(req, res) {
    try {

        const parsed = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const prompt = parsed.prompt;
        const county = normalizeCounty(parsed.county);
        const state = String(parsed.state || '').trim();

        if (!prompt) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Prompt is required' }));
            return;
        }

        if (!county) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'No county is associated with your account' }));
            return;
        }

        if (!state) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'State is required' }));
            return;
        }

        if (!isRegisteredState(state)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Please select a valid state' }));
            return;
        }

        if (!process.env.GEMINI_API_KEY) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Missing GEMINI_API_KEY' }));
            return;
        }

        const uploads = await readUploads();
        const normalizedState = state.trim().toLowerCase();
        const countyCandidates = uploads.filter(
            (item) => normalizeCounty(item.county) === county
        );
        const hasStateAwareRecords = countyCandidates.some((item) =>
            Boolean(String(item.state || '').trim())
        );
        const countyUploads = hasStateAwareRecords
            ? countyCandidates.filter((item) => {
                const itemState = String(item.state || '').trim().toLowerCase();
                return itemState === normalizedState;
            })
            : countyCandidates;
        const rankedMatches = await rankHybrid(countyUploads, prompt);

        if (rankedMatches.length === 0 || rankedMatches[0].score < MIN_CONFIDENCE_SCORE) {
            res.statusCode = 200;
            res.end(JSON.stringify({ result: 'I do not have that information.', sources: [] }));
            return;
        }

        const matches = rankedMatches.map((item) => item.record);

        const context = matches
            .map((item, index) => `[${index + 1}] (${item.source}) ${item.text}`)
            .join('\n\n');

        const model = genAi.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction:
                'Answer only using the provided context. If the answer is not present, reply exactly: I do not have that information.',
            generationConfig: {
                temperature: 0.2,
            },
        });

        const groundedPrompt = `Context:\n${context}\n\nQuestion:\n${prompt}`;
        const result = await model.generateContent(groundedPrompt);
        let text = result.response.text();

        if (/^i do not have that information\.?$/i.test(String(text).trim())) {
            const fallback = extractRelevantLines(matches, prompt);
            if (fallback) {
                text = fallback;
            }
        }

        const sources = /^i do not have that information\.?$/i.test(String(text).trim())
            ? []
            : getSupportingSources(matches, text);

        res.statusCode = 200;
        res.end(
            JSON.stringify({
                result: text,
                sources: sources.map((item) => ({ id: item.id, source: item.source })),
            })
        );
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.end(JSON.stringify({ error: error.message || 'Bad Request' }));
    }
}

module.exports = {
    getSearch,
    postSearch,
};
