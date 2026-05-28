require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { readUploads } = require('../lib/uploadStore');
const helperController = require('./helperController');
const { normalizeCounty, isRegisteredState } = require('../lib/countyRegistry');

const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_JSON_BYTES = 1 * 1024 * 1024;

function tokenize(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
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
        .slice(0, max)
        .map((item) => item.record);
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
        const countyUploads = uploads.filter((item) => normalizeCounty(item.county) === county);
        const matches = rankByOverlap(countyUploads, prompt);

        if (matches.length === 0) {
            res.statusCode = 200;
            res.end(JSON.stringify({ result: 'I do not have that information.', sources: [] }));
            return;
        }

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

        res.statusCode = 200;
        res.end(
            JSON.stringify({
                result: text,
                sources: matches.map((item) => ({ id: item.id, source: item.source })),
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
