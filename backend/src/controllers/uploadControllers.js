const { readUploads, writeUploads } = require('../lib/uploadStore');
const { parseFile } = require('../lib/fileParser');
const helperController = require('./helperController');
const { normalizeCounty } = require('../lib/countyRegistry');

const maxUploadSize = 10 * 1024 * 1024; // 10 MB per file
const MAX_JSON_BYTES = 25 * 1024 * 1024; // account for base64 overhead
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

function createId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeChunkText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim();
}

function findChunkEnd(text, start, maxEnd) {
    const slice = text.slice(start, maxEnd);
    const newlineBreak = slice.lastIndexOf('\n');
    if (newlineBreak >= CHUNK_SIZE * 0.5) {
        return start + newlineBreak + 1;
    }

    const sentenceBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
    if (sentenceBreak >= CHUNK_SIZE * 0.5) {
        return start + sentenceBreak + 1;
    }

    const whitespaceBreak = slice.lastIndexOf(' ');
    if (whitespaceBreak >= CHUNK_SIZE * 0.5) {
        return start + whitespaceBreak + 1;
    }

    return maxEnd;
}

function chunkText(rawText, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const text = normalizeChunkText(rawText);
    if (!text) {
        return [];
    }

    if (text.length <= chunkSize) {
        return [text];
    }

    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const maxEnd = Math.min(start + chunkSize, text.length);
        const end = findChunkEnd(text, start, maxEnd);
        const chunk = text.slice(start, end).trim();

        if (chunk) {
            chunks.push(chunk);
        }

        if (end >= text.length) {
            break;
        }

        const nextStart = Math.max(end - overlap, start + 1);
        start = nextStart;
    }

    return chunks;
}

function normalizeParsed(parsed, source, county) {
    const sourceName = source || parsed?.metadata?.name || 'unknown';

    if (Array.isArray(parsed.structured)) {
        return parsed.structured.map((item, index) => ({
            id: createId(),
            source: sourceName,
            text: typeof item === 'object' ? JSON.stringify(item) : String(item),
            parsedType: parsed.parsedType,
            metadata: parsed.metadata,
            structured: item,
            county,
            rowIndex: index,
            chunkIndex: 0,
            chunkCount: 1,
            createdAt: new Date().toISOString(),
        }));
    }

    const baseText = parsed.rawText || (parsed.structured ? JSON.stringify(parsed.structured, null, 2) : '');
    const chunks = chunkText(baseText);

    if (chunks.length === 0) {
        return [];
    }

    const chunkCount = chunks.length;

    return chunks.map((chunk, index) => ({
        id: createId(),
        source: sourceName,
        text: chunk,
        parsedType: parsed.parsedType,
        metadata: parsed.metadata,
        structured: parsed.structured,
        county,
        chunkIndex: index,
        chunkCount,
        createdAt: new Date().toISOString(),
    }));
}

async function uploadFile(req, res) {
    try {
        const user = helperController.getAuthenticatedUser(req, { includeState: false, cleanupExpired: true });
        if (!user) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'You must be signed in to upload' }));
            return;
        }

        const payload = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const county = normalizeCounty(user.county);
        const existing = await readUploads();

        if (!county) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'No county found on your account' }));
            return;
        }

        const incomingFiles = Array.isArray(payload.files)
            ? payload.files
            : payload.file
                ? [payload.file]
                : [];

        if (incomingFiles.length === 0) {
            res.statusCode = 422;
            res.end(
                JSON.stringify({
                    error:
                        'Invalid upload payload. Send: { files: [{ name, type, size, base64 }] }',
                })
            );
            return;
        }

        let normalized = [];

        for (const inputFile of incomingFiles) {
            const base64Input = String(inputFile?.base64 || '');
            const base64 = base64Input.includes(',') ? base64Input.split(',')[1] : base64Input;
            const buffer = Buffer.from(base64, 'base64');

            if (!buffer.length) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Invalid base64 file payload for ${inputFile?.name || 'unknown file'}` }));
                return;
            }

            if (buffer.length > maxUploadSize) {
                res.statusCode = 413;
                res.end(JSON.stringify({ error: `File size exceeds limit for ${inputFile?.name || 'unknown file'}` }));
                return;
            }

            const parsed = await parseFile({
                originalname: inputFile.name || payload.source || 'upload.bin',
                mimetype: inputFile.type || inputFile.mimeType || 'application/octet-stream',
                buffer,
                size: inputFile.size || null,
            });

            if (!parsed.rawText && !parsed.structured) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Parsed file has no content: ${inputFile?.name || 'unknown file'}` }));
                return;
            }

            normalized = normalized.concat(
                normalizeParsed(parsed, payload.source || inputFile.name, county)
            );
        }

        if (normalized.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'No valid upload content found' }));
            return;
        }

        const updated = existing.concat(normalized);
        await writeUploads(updated);

        res.statusCode = 201;
        res.end(JSON.stringify({
            filesProcessed: incomingFiles.length,
            added: normalized.length,
            total: updated.length,
        }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.end(JSON.stringify({ error: error.message || 'Bad Request' }));
    }
}

async function getUpload(req, res) {
    const user = helperController.getAuthenticatedUser(req, { includeState: false, cleanupExpired: true });
    if (!user) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'You must be signed in' }));
        return;
    }

    const county = normalizeCounty(user.county);
    const uploads = await readUploads();
    const countyUploads = uploads.filter((item) => normalizeCounty(item.county) === county);
    res.statusCode = 200;
    res.end(JSON.stringify({ total: countyUploads.length, uploads: countyUploads }));
}

async function deleteUpload(req, res) {
    try {
        const user = helperController.getAuthenticatedUser(req, { includeState: false, cleanupExpired: true });
        if (!user) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'You must be signed in' }));
            return;
        }

        const county = normalizeCounty(user.county);
        const payload = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const uploads = await readUploads();

        const isOwnedByCounty = (item) => normalizeCounty(item.county) === county;
        let filtered = uploads;

        if (payload.id) {
            filtered = uploads.filter((item) => !(item.id === payload.id && isOwnedByCounty(item)));
        } else if (payload.source) {
            filtered = uploads.filter((item) => !(item.source === payload.source && isOwnedByCounty(item)));
        } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Provide id or source to delete' }));
            return;
        }

        const deleted = uploads.length - filtered.length;
        if (deleted === 0) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'No matching upload found for your county' }));
            return;
        }

        await writeUploads(filtered);
        res.statusCode = 200;
        res.end(JSON.stringify({ deleted, total: filtered.length }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.end(JSON.stringify({ error: error.message || 'Bad Request' }));
    }
}

module.exports = {
    uploadFile,
    getUpload,
    deleteUpload,
};
