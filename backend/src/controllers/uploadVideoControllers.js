const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readUploads, writeUploads } = require("../lib/uploadStore");
const { attachEmbeddings } = require("../lib/embeddings");
const { createId, chunkText, normalizeChunkText } = require("./uploadFilesControllers");
const helperController = require("./helperController");
const { normalizeCounty } = require("../lib/countyRegistry");

const VIDEO_UPLOAD_DIR = path.join(__dirname, "../../data/videos");
const VIDEO_AUDIO_DIR = path.join(__dirname, "../../data/audio");
const VIDEO_RECORDS_DIR = path.join(__dirname, "../../data/video_records");
const VIDEO_TRANSCRIPTS_DIR = path.join(__dirname, "../../data/video_transcripts");
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const EMBEDDING_CONCURRENCY = 4;
const WHISPER_CPP_BIN = process.env.WHISPER_CPP_BIN || "whisper-cli";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || "";
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || "4");
const MIME_EXTENSION_MAP = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/x-matroska": ".mkv",
};
const VALID_VIDEO_EXTENSIONS = new Set(Object.values(MIME_EXTENSION_MAP));

function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

function decodeFilenameHeader(value) {
    const raw = String(value || "");
    if (!raw) {
        return "";
    }

    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function resolveVideoExtension({ videoPath, contentType }) {
    const extFromPath = path.extname(String(videoPath || "")).toLowerCase();
    const extFromType = MIME_EXTENSION_MAP[String(contentType || "").toLowerCase()] || "";
    const ext = extFromPath || extFromType;

    if (!VALID_VIDEO_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported video format: ${ext || "unknown"}`);
    }

    return ext;
}

function getVideoRecordPath(recordId) {
    return path.join(VIDEO_RECORDS_DIR, `${recordId}.json`);
}

async function readVideoRecord(recordId) {
    const raw = await fs.readFile(getVideoRecordPath(recordId), "utf8");
    return JSON.parse(raw);
}

async function writeVideoRecord(record) {
    await fs.mkdir(VIDEO_RECORDS_DIR, { recursive: true });
    await fs.writeFile(
        getVideoRecordPath(record.id),
        JSON.stringify(record, null, 2),
        "utf8",
    );
}

async function updateVideoRecord(record, patch) {
    const nextRecord = {
        ...record,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    await writeVideoRecord(nextRecord);
    return nextRecord;
}

async function createVideoRecord({
    id,
    videoPath,
    extension,
    contentType,
    sourceName,
    size,
    county,
    state,
}) {
    const now = new Date().toISOString();
    const record = {
        id,
        videoPath,
        extension,
        contentType,
        sourceName,
        size,
        county,
        state,
        status: "uploaded",
        transcript: null,
        transcriptSummary: null,
        audioPath: null,
        error: null,
        createdAt: now,
        updatedAt: now,
    };

    await writeVideoRecord(record);
    return record;
}

async function validateVideoFile(videoPath) {
    await fs.access(videoPath, fsSync.constants.R_OK);
    resolveVideoExtension({ videoPath });

    const stat = await fs.stat(videoPath);
    if (stat.size <= 0) {
        throw new Error("Video file is empty");
    }
}

async function extractAudioFromVideo(videoPath, audioPath) {
    await fs.mkdir(path.dirname(audioPath), { recursive: true });

    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-i",
            videoPath,
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            audioPath,
        ];

        const ffmpegProcess = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";

        ffmpegProcess.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        ffmpegProcess.on("error", (error) => {
            reject(new Error(`Failed to start ffmpeg: ${error.message}`));
        });

        ffmpegProcess.on("close", (code) => {
            if (code === 0) {
                resolve(audioPath);
                return;
            }

            reject(
                new Error(
                    `Audio extraction failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
                ),
            );
        });
    });
}

async function transcribeAudioWithWhisper(audioPath) {
    if (!WHISPER_MODEL_PATH) {
        throw new Error("Missing WHISPER_MODEL_PATH for local whisper.cpp transcription");
    }

    await fs.access(WHISPER_MODEL_PATH, fsSync.constants.R_OK);
    await fs.mkdir(VIDEO_TRANSCRIPTS_DIR, { recursive: true });

    const outputPrefix = path.join(VIDEO_TRANSCRIPTS_DIR, `${path.basename(audioPath, path.extname(audioPath))}-${createId()}`);
    const outputJsonPath = `${outputPrefix}.json`;

    return new Promise((resolve, reject) => {
        const args = [
            "-m",
            WHISPER_MODEL_PATH,
            "-f",
            audioPath,
            "-oj",
            "-of",
            outputPrefix,
            "-l",
            "auto",
            "-t",
            String(Number.isFinite(WHISPER_THREADS) && WHISPER_THREADS > 0 ? WHISPER_THREADS : 4),
        ];

        const whisperProcess = spawn(WHISPER_CPP_BIN, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        whisperProcess.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        whisperProcess.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        whisperProcess.on("error", (error) => {
            reject(
                new Error(
                    `Failed to start local whisper binary (${WHISPER_CPP_BIN}): ${error.message}`,
                ),
            );
        });

        whisperProcess.on("close", async (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        `Local whisper transcription failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
                    ),
                );
                return;
            }

            try {
                const rawJson = await fs.readFile(outputJsonPath, "utf8");
                resolve(JSON.parse(rawJson));
            } catch {
                resolve({ text: normalizeChunkText(stdout), transcription: [] });
            }
        });
    });
}

function normalizeTranscript(transcript) {
    const segmentList = Array.isArray(transcript?.segments)
        ? transcript.segments
        : Array.isArray(transcript?.transcription)
            ? transcript.transcription.map((segment, index) => ({
                index,
                start: Number.isFinite(Number(segment?.offsets?.from))
                    ? Number(segment.offsets.from)
                    : null,
                end: Number.isFinite(Number(segment?.offsets?.to))
                    ? Number(segment.offsets.to)
                    : null,
                text: String(segment?.text || "").trim(),
            }))
            : [];
    const textFromSegments = segmentList
        .map((segment) => String(segment?.text || "").trim())
        .filter(Boolean)
        .join(" ");
    const text = normalizeChunkText(transcript?.text || textFromSegments);

    return {
        text,
        language: String(transcript?.language || "").trim() || null,
        duration: Number.isFinite(Number(transcript?.duration))
            ? Number(transcript.duration)
            : null,
        segments: segmentList.map((segment, index) => ({
            index,
            start: Number.isFinite(Number(segment?.start))
                ? Number(segment.start)
                : null,
            end: Number.isFinite(Number(segment?.end)) ? Number(segment.end) : null,
            text: String(segment?.text || "").trim(),
        })),
    };
}

function buildTranscriptUploadRecords(record, normalizedTranscript, transcriptChunks) {
    const chunkCount = transcriptChunks.length;

    return transcriptChunks.map((chunk, index) => ({
        id: createId(),
        source: record.sourceName,
        text: chunk,
        parsedType: "whisper_transcript",
        metadata: {
            videoId: record.id,
            sourceName: record.sourceName,
            language: normalizedTranscript.language,
            duration: normalizedTranscript.duration,
            segmentCount: normalizedTranscript.segments.length,
            audioPath: record.audioPath,
        },
        structured: {
            segments: normalizedTranscript.segments,
        },
        county: record.county,
        state: record.state,
        chunkIndex: index,
        chunkCount,
        createdAt: new Date().toISOString(),
    }));
}

async function upsertTranscriptUploads(records) {
    const existing = await readUploads();
    await writeUploads(existing.concat(records));
}

async function uploadVideoFile(req, res) {
    const user = helperController.getAuthenticatedUser(req, {
        includeState: true,
        cleanupExpired: true,
    });

    if (!user) {
        sendJson(res, 401, { error: "You must be signed in to upload" });
        return;
    }

    const id = createId();
    const contentType = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    const incomingName = decodeFilenameHeader(
        req.headers["x-file-name"] || req.headers["x-upload-filename"],
    );

    let extension;
    try {
        extension = resolveVideoExtension({
            videoPath: incomingName,
            contentType,
        });
    } catch (error) {
        sendJson(res, 415, { error: error.message });
        return;
    }

    await fs.mkdir(VIDEO_UPLOAD_DIR, { recursive: true });

    const filename = `${id}${extension}`;
    const filePath = path.join(VIDEO_UPLOAD_DIR, filename);
    const writeStream = fsSync.createWriteStream(filePath, { flags: "wx" });

    let bytesWritten = 0;
    let finalized = false;

    const finalizeWithError = async (statusCode, message) => {
        if (finalized) {
            return;
        }
        finalized = true;
        writeStream.destroy();

        try {
            await fs.unlink(filePath);
        } catch {
            // ignore cleanup failures for partial files
        }

        sendJson(res, statusCode, { error: message });
    };

    req.on("data", (chunk) => {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_VIDEO_BYTES) {
            req.destroy(new Error("Video upload exceeds maximum size"));
        }
    });

    req.on("aborted", () => {
        void finalizeWithError(400, "Upload aborted by client");
    });

    req.on("error", (error) => {
        void finalizeWithError(400, error.message || "Upload failed");
    });

    writeStream.on("error", (error) => {
        void finalizeWithError(500, error.message || "Failed to write video file");
    });

    writeStream.on("finish", async () => {
        if (finalized) {
            return;
        }

        try {
            await validateVideoFile(filePath);
            const record = await createVideoRecord({
                id,
                videoPath: filePath,
                extension,
                contentType,
                sourceName: path
                    .basename(incomingName || filename)
                    .replace(/[\r\n"]/g, "_"),
                size: bytesWritten,
                county: normalizeCounty(user.county),
                state: String(user.state_abbreviation || user.state_name || "").trim(),
            });

            finalized = true;
            sendJson(res, 201, {
                id: record.id,
                status: record.status,
                file: path.basename(record.videoPath),
            });

            void processVideoFile(record.id);
        } catch (error) {
            await finalizeWithError(400, error.message || "Invalid uploaded video");
        }
    });

    req.pipe(writeStream);
}

async function processVideoFile(recordId) {
    let record;
    try {
        record = await readVideoRecord(recordId);
    } catch {
        return { success: false, error: "Record not found" };
    }

    const audioPath = path.join(VIDEO_AUDIO_DIR, `${record.id}.wav`);

    try {
        record = await updateVideoRecord(record, {
            status: "processing",
            error: null,
        });

        await extractAudioFromVideo(record.videoPath, audioPath);
        record = await updateVideoRecord(record, {
            status: "audio_extracted",
            audioPath,
        });

        const whisperTranscript = await transcribeAudioWithWhisper(audioPath);
        const normalizedTranscript = normalizeTranscript(whisperTranscript);
        const transcriptChunks = chunkText(normalizedTranscript.text);

        if (transcriptChunks.length === 0) {
            throw new Error("Whisper returned no transcript text");
        }

        const uploadRecords = buildTranscriptUploadRecords(
            record,
            normalizedTranscript,
            transcriptChunks,
        );
        await attachEmbeddings(uploadRecords, { concurrency: EMBEDDING_CONCURRENCY });
        await upsertTranscriptUploads(uploadRecords);

        await updateVideoRecord(record, {
            status: "completed",
            transcript: normalizedTranscript,
            transcriptSummary: {
                chunkCount: transcriptChunks.length,
                language: normalizedTranscript.language,
                duration: normalizedTranscript.duration,
                segmentCount: normalizedTranscript.segments.length,
            },
            error: null,
        });

        return {
            success: true,
            audioPath,
            chunkCount: transcriptChunks.length,
        };
    } catch (error) {
        await updateVideoRecord(record, {
            status: "failed",
            error: error.message,
        });
        return { success: false, error: error.message };
    }
}

async function getVideoStatus(req, res, recordId) {
    try {
        const record = await readVideoRecord(recordId);
        sendJson(res, 200, {
            id: record.id,
            status: record.status,
            error: record.error,
            updatedAt: record.updatedAt,
        });
    } catch (error) {
        sendJson(res, 404, { error: error.message || "Video record not found" });
    }
}

async function getVideoTranscript(req, res, recordId) {
    try {
        const record = await readVideoRecord(recordId);

        if (!record.transcript) {
            sendJson(res, record.status === "failed" ? 422 : 409, {
                error:
                    record.status === "failed"
                        ? record.error || "Video processing failed"
                        : "Transcript not ready",
                status: record.status,
            });
            return;
        }

        sendJson(res, 200, {
            id: record.id,
            status: record.status,
            transcript: record.transcript,
            transcriptSummary: record.transcriptSummary,
            error: record.error,
            updatedAt: record.updatedAt,
        });
    } catch (error) {
        sendJson(res, 404, { error: error.message || "Video record not found" });
    }
}

module.exports = {
    uploadVideoFile,
    getVideoStatus,
    getVideoTranscript,
};