const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  readChunks,
  deleteChunksById,
  findChunkIds,
} = require("../lib/uploadStore");
const { deleteChunks } = require("../lib/vectorStore");
const {
  MAX_FILE_BYTES,
  createId,
  chunkText,
  normalizeChunkText,
  buildRecords,
  embedRecords,
  storeRecords,
  removeSource,
} = require("../lib/ingest");
const helperController = require("./helperController");
const { normalizeCounty } = require("../lib/countyRegistry");

const MAX_JSON_BYTES = 25 * 1024 * 1024; // account for base64 overhead
const DOCUMENTS_DIR = path.join(__dirname, "../../data/documents");

// Chunks are stored with the state abbreviation; reads/deletes must match it.
function userState(user) {
  return String(user?.state_abbreviation || user?.state_name || "").trim();
}

async function uploadFile(req, res) {
  try {
    const user = await helperController.getAuthenticatedUser(req, {
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
    const state = userState(user);

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

      if (buffer.length > MAX_FILE_BYTES) {
        res.statusCode = 413;
        res.end(
          JSON.stringify({
            error: `File size exceeds limit for ${inputFile?.name || "unknown file"}`,
          }),
        );
        return;
      }

      let built;
      try {
        built = await buildRecords({
          buffer,
          name: inputFile.name || payload.source || "upload.bin",
          mimeType:
            inputFile.type || inputFile.mimeType || "application/octet-stream",
          size: inputFile.size || null,
          county,
          state,
          sourceName: payload.source || inputFile.name,
        });
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message || "Bad Request" }));
        return;
      }

      if (built.documentSaved) documentsSaved += 1;
      normalized = normalized.concat(built.records);
    }

    await embedRecords(normalized);

    if (normalized.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "No valid upload content found" }));
      return;
    }

    await storeRecords(normalized);

    res.statusCode = 201;
    res.end(
      JSON.stringify({
        filesProcessed: incomingFiles.length,
        documentsSaved,
        added: normalized.length,
      }),
    );
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.end(JSON.stringify({ error: error.message || "Bad Request" }));
  }
}

async function getUpload(req, res) {
  const user = await helperController.getAuthenticatedUser(req, {
    includeState: true,
    cleanupExpired: true,
  });
  if (!user) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "You must be signed in" }));
    return;
  }

  const county = normalizeCounty(user.county);
  const state = userState(user);
  if (!county || !state) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "No county/state found on your account" }));
    return;
  }
  const countyUploads = await readChunks({ county, state });
  res.statusCode = 200;
  res.end(
    JSON.stringify({ total: countyUploads.length, uploads: countyUploads }),
  );
}

function isPathInsideDocumentsRoot(storedPath) {
  const absoluteStoredPath = path.resolve(String(storedPath || ""));
  const allowedDocumentsRoot = path.resolve(DOCUMENTS_DIR);

  return absoluteStoredPath === allowedDocumentsRoot ||
    absoluteStoredPath.startsWith(`${allowedDocumentsRoot}${path.sep}`)
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
  const sourceLower = String(source || "")
    .trim()
    .toLowerCase();
  const normalizedCounty = normalizeCounty(county || "");
  const normalizedState = String(state || "")
    .trim()
    .toLowerCase();

  return (
    uploads.find((item) => {
      if (item?.parsedType !== "pdf") {
        return false;
      }

      if (
        String(item?.source || "")
          .trim()
          .toLowerCase() !== sourceLower
      ) {
        return false;
      }

      if (
        normalizedCounty &&
        normalizeCounty(item?.county) !== normalizedCounty
      ) {
        return false;
      }

      if (normalizedState) {
        const itemState = String(item?.state || "")
          .trim()
          .toLowerCase();
        if (itemState !== normalizedState) {
          return false;
        }
      }

      return typeof item?.originalStoredPath === "string";
    }) || null
  );
}

async function streamPdfRecord(res, record, fallbackName = "document.pdf") {
  const absoluteStoredPath = isPathInsideDocumentsRoot(
    record?.originalStoredPath,
  );

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

    const chunks = await readChunks({ documentId: requestedId });
    const record =
      chunks.find(
        (item) =>
          item.parsedType === "pdf" &&
          typeof item.originalStoredPath === "string",
      ) ?? null;

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

    const chunks = await readChunks({ source, county, state });
    const record =
      chunks.find(
        (item) =>
          item.parsedType === "pdf" &&
          typeof item.originalStoredPath === "string",
      ) ?? null;

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
    const user = await helperController.getAuthenticatedUser(req, {
      includeState: true,
      cleanupExpired: true,
    });
    if (!user) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "You must be signed in" }));
      return;
    }

    const county = normalizeCounty(user.county);
    const state = userState(user);
    if (!county || !state) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "No county/state found on your account" }));
      return;
    }
    const payload = await helperController.parseJsonBody(req, MAX_JSON_BYTES);

    let deleted = 0;

    if (payload.id) {
      const ids = await findChunkIds({ id: payload.id, county, state });
      if (ids.length > 0) {
        try {
          await deleteChunks(ids);
        } catch { }
      }
      deleted = await deleteChunksById(payload.id, county, state);
    } else if (payload.source) {
      deleted = await removeSource(payload.source, county, state);
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Provide id or source to delete" }));
      return;
    }

    if (deleted === 0) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({ error: "No matching upload found for your county" }),
      );
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ deleted }));
  } catch (error) {
    res.statusCode = error.message === "Payload too large" ? 413 : 400;
    res.end(JSON.stringify({ error: error.message || "Bad Request" }));
  }
}

module.exports = {
  createId,
  chunkText,
  normalizeChunkText,
  uploadFile,
  getUpload,
  getOriginalDocument,
  getOriginalDocumentBySource,
  deleteUpload,
};
