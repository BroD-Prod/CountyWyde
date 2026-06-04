const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readUploads, writeUploads } = require("../lib/uploadStore");
const { parseFile } = require("../lib/fileParser");
const { attachEmbeddings } = require("../lib/embeddings");
const helperController = require("./helperController");
const { normalizeCounty } = require("../lib/countyRegistry");

const maxUploadSize = 10 * 1024 * 1024; // 10 MB per file
const MAX_JSON_BYTES = 25 * 1024 * 1024; // account for base64 overhead
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const EMBEDDING_CONCURRENCY = 4;
const DOCUMENTS_DIR = path.join(__dirname, "../../data/documents");

function createId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function persistOriginalPdf({
    buffer,
    sourceName,
    mimeType,
    county,
    state,
}) {
    const documentId = createId();
    const safeSourceName = String(sourceName || "upload.pdf").replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
    );
    const filename = `${documentId}-${safeSourceName.endsWith(".pdf") ? safeSourceName : `${safeSourceName}.pdf`}`;

    await fs.mkdir(DOCUMENTS_DIR, { recursive: true });

    const absolutePath = path.join(DOCUMENTS_DIR, filename);
    await fs.writeFile(absolutePath, buffer);

    return {
        documentId,
        originalName: sourceName,
        mimeType: mimeType || "application/pdf",
        size: buffer.length,
        county,
        state,
        storedFilename: filename,
        storedPath: absolutePath,
        createdAt: new Date().toISOString(),
    };
}

function normalizeChunkText(text) {
    return String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\u0000/g, "")
        .trim();
}

function findChunkEnd(text, start, maxEnd) {
    const slice = text.slice(start, maxEnd);
    const newlineBreak = slice.lastIndexOf("\n");
    if (newlineBreak >= CHUNK_SIZE * 0.5) {
        return start + newlineBreak + 1;
    }

    const sentenceBreak = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
    );
    if (sentenceBreak >= CHUNK_SIZE * 0.5) {
        return start + sentenceBreak + 1;
    }

    const whitespaceBreak = slice.lastIndexOf(" ");
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

function normalizeParsed(parsed, source, county, state) {
    const sourceName = source || parsed?.metadata?.name || "unknown";

    if (Array.isArray(parsed.structured)) {
        return parsed.structured.map((item, index) => ({
            id: createId(),
            source: sourceName,
            text: typeof item === "object" ? JSON.stringify(item) : String(item),
            parsedType: parsed.parsedType,
            metadata: parsed.metadata,
            structured: item,
            county,
            state,
            rowIndex: index,
            chunkIndex: 0,
            chunkCount: 1,
            createdAt: new Date().toISOString(),
        }));
    }

    const baseText =
        parsed.rawText ||
        (parsed.structured ? JSON.stringify(parsed.structured, null, 2) : "");
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
        state,
        chunkIndex: index,
        chunkCount,
        createdAt: new Date().toISOString(),
    }));
}

async function uploadFile(req, res) {
    try {
        const user = helperController.getAuthenticatedUser(req, {
            includeState: true,
            cleanupExpired: true,
        });
        if (!user) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: "You must be signed in to upload" }));
            return;
        }

        const payload = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const county = normalizeCounty(user.county);
        const state = String(
            user.state_abbreviation || user.state_name || "",
        ).trim();
        const existing = await readUploads();

        if (!county || !state) {
            res.statusCode = 400;
            res.end(
                JSON.stringify({ error: "No county/state found on your account" }),
            );
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
                        "Invalid upload payload. Send: { files: [{ name, type, size, base64 }] }",
                }),
            );
            return;
        }

        let normalized = [];
        let documentsSaved = 0;

        for (const inputFile of incomingFiles) {
            const base64Input = String(inputFile?.base64 || "");
            const base64 = base64Input.includes(",")
                ? base64Input.split(",")[1]
                : base64Input;
            const buffer = Buffer.from(base64, "base64");

            if (!buffer.length) {
                res.statusCode = 400;
                res.end(
                    JSON.stringify({
                        error: `Invalid base64 file payload for ${inputFile?.name || "unknown file"}`,
                    }),
                );
                return;
            }

            if (buffer.length > maxUploadSize) {
                res.statusCode = 413;
                res.end(
                    JSON.stringify({
                        error: `File size exceeds limit for ${inputFile?.name || "unknown file"}`,
                    }),
                );
                return;
            }

            const parsed = await parseFile({
                originalname: inputFile.name || payload.source || "upload.bin",
                mimetype:
                    inputFile.type || inputFile.mimeType || "application/octet-stream",
                buffer,
                size: inputFile.size || null,
            });

            let documentMetadata = null;
            if (parsed.parsedType === "pdf") {
                documentMetadata = await persistOriginalPdf({
                    buffer,
                    sourceName: inputFile.name || payload.source || "unknown.pdf",
                    mimeType: inputFile.type || inputFile.mimeType || "application/pdf",
                    county,
                    state,
                });
                documentsSaved += 1;
            }

            if (!parsed.rawText && !parsed.structured) {
                res.statusCode = 400;
                res.end(
                    JSON.stringify({
                        error: `Parsed file has no content: ${inputFile?.name || "unknown file"}`,
                    }),
                );
                return;
            }

            const parsedRecords = normalizeParsed(
                parsed,
                payload.source || inputFile.name,
                county,
                state,
            );

            const recordsWithDocument = documentMetadata
                ? parsedRecords.map((record) => ({
                    ...record,
                    documentId: documentMetadata.documentId,
                    originalFileName: documentMetadata.originalName,
                    originalMimeType: documentMetadata.mimeType,
                    originalSize: documentMetadata.size,
                    originalStoredFilename: documentMetadata.storedFilename,
                    originalStoredPath: documentMetadata.storedPath,
                    originalStoredAt: documentMetadata.createdAt,
                }))
                : parsedRecords;

            normalized = normalized.concat(recordsWithDocument);
        }

        await attachEmbeddings(normalized, { concurrency: EMBEDDING_CONCURRENCY });

        if (normalized.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid upload content found" }));
            return;
        }

        const updated = existing.concat(normalized);
        await writeUploads(updated);

        res.statusCode = 201;
        res.end(
            JSON.stringify({
                filesProcessed: incomingFiles.length,
                documentsSaved,
                added: normalized.length,
                total: updated.length,
            }),
        );
    } catch (error) {
        res.statusCode = error.message === "Payload too large" ? 413 : 400;
        res.end(JSON.stringify({ error: error.message || "Bad Request" }));
    }
}

async function getUpload(req, res) {
    const user = helperController.getAuthenticatedUser(req, {
        includeState: false,
        cleanupExpired: true,
    });
    if (!user) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "You must be signed in" }));
        return;
    }

    const county = normalizeCounty(user.county);
    const uploads = await readUploads();
    const countyUploads = uploads.filter(
        (item) => normalizeCounty(item.county) === county,
    );
    res.statusCode = 200;
    res.end(
        JSON.stringify({ total: countyUploads.length, uploads: countyUploads }),
    );
}

function isPathInsideDocumentsRoot(storedPath) {
    const absoluteStoredPath = path.resolve(String(storedPath || ""));
    const allowedDocumentsRoot = path.resolve(DOCUMENTS_DIR);

    return (
        absoluteStoredPath === allowedDocumentsRoot ||
        absoluteStoredPath.startsWith(`${allowedDocumentsRoot}${path.sep}`)
    )
        ? absoluteStoredPath
        : null;
}

function findPdfRecordByDocumentId(uploads, requestedId) {
    return (
        uploads.find(
            (item) =>
                item?.parsedType === "pdf" &&
                String(item?.documentId || "") === requestedId &&
                typeof item?.originalStoredPath === "string",
        ) || null
    );
}

function findPdfRecordBySource(uploads, { source, county, state }) {
    const sourceLower = String(source || "").trim().toLowerCase();
    const normalizedCounty = normalizeCounty(county || "");
    const normalizedState = String(state || "").trim().toLowerCase();

    return (
        uploads.find((item) => {
            if (item?.parsedType !== "pdf") {
                return false;
            }

            if (String(item?.source || "").trim().toLowerCase() !== sourceLower) {
                return false;
            }

            if (normalizedCounty && normalizeCounty(item?.county) !== normalizedCounty) {
                return false;
            }

            if (normalizedState) {
                const itemState = String(item?.state || "").trim().toLowerCase();
                if (itemState !== normalizedState) {
                    return false;
                }
            }

            return typeof item?.originalStoredPath === "string";
        }) || null
    );
}

async function streamPdfRecord(res, record, fallbackName = "document.pdf") {
    const absoluteStoredPath = isPathInsideDocumentsRoot(record?.originalStoredPath);

    if (!absoluteStoredPath) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid document path" }));
        return;
    }

    try {
        await fs.access(absoluteStoredPath);
    } catch {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Document file is missing" }));
        return;
    }

    const downloadName = String(record.originalFileName || fallbackName).replace(
        /[\r\n"]/g,
        "_",
    );

    res.statusCode = 200;
    res.removeHeader("X-Frame-Options");
    res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' http://localhost:3000",
    );
    res.setHeader("Content-Type", record.originalMimeType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);

    const stream = fsSync.createReadStream(absoluteStoredPath);
    stream.on("error", () => {
        if (!res.writableEnded) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Unable to read document file" }));
        }
    });
    stream.pipe(res);
}

async function getOriginalDocument(req, res, documentId) {
    try {
        const requestedId = String(documentId || "").trim();
        if (!requestedId) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Document id is required" }));
            return;
        }

        const uploads = await readUploads();
        const record = findPdfRecordByDocumentId(uploads, requestedId);

        if (!record) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Document not found" }));
            return;
        }

        await streamPdfRecord(res, record, `${requestedId}.pdf`);
    } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message || "Bad Request" }));
    }
}

async function getOriginalDocumentBySource(req, res) {
    try {
        const requestUrl = new URL(req.url, "http://localhost:1337");
        const source = String(requestUrl.searchParams.get("source") || "").trim();
        const county = normalizeCounty(requestUrl.searchParams.get("county") || "");
        const state = String(requestUrl.searchParams.get("state") || "")
            .trim()
            .toLowerCase();

        if (!source) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "source query param is required" }));
            return;
        }

        const uploads = await readUploads();
        const record = findPdfRecordBySource(uploads, { source, county, state });

        if (!record) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Document not found" }));
            return;
        }

        await streamPdfRecord(res, record, record.source || "document.pdf");
    } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message || "Bad Request" }));
    }
}

async function deleteUpload(req, res) {
    try {
        const user = helperController.getAuthenticatedUser(req, {
            includeState: false,
            cleanupExpired: true,
        });
        if (!user) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: "You must be signed in" }));
            return;
        }

        const county = normalizeCounty(user.county);
        const payload = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const uploads = await readUploads();

        const isOwnedByCounty = (item) => normalizeCounty(item.county) === county;
        let filtered = uploads;

        if (payload.id) {
            filtered = uploads.filter(
                (item) => !(item.id === payload.id && isOwnedByCounty(item)),
            );
        } else if (payload.source) {
            filtered = uploads.filter(
                (item) => !(item.source === payload.source && isOwnedByCounty(item)),
            );
        } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Provide id or source to delete" }));
            return;
        }

        const deleted = uploads.length - filtered.length;
        if (deleted === 0) {
            res.statusCode = 404;
            res.end(
                JSON.stringify({ error: "No matching upload found for your county" }),
            );
            return;
        }

        await writeUploads(filtered);
        res.statusCode = 200;
        res.end(JSON.stringify({ deleted, total: filtered.length }));
    } catch (error) {
        res.statusCode = error.message === "Payload too large" ? 413 : 400;
        res.end(JSON.stringify({ error: error.message || "Bad Request" }));
    }
}

module.exports = {
    uploadFile,
    getUpload,
    getOriginalDocument,
    getOriginalDocumentBySource,
    deleteUpload,
};
