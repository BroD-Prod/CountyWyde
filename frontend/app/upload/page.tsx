"use client";
import { useEffect, useState } from "react";
import { useAlert } from "../components/AlertProvider";

const API_BASE = process.env.API_BASE || "http://localhost:1337";

const POLL_INTERVAL_MS = 2500;
const DOCUMENT_ALLOWED_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const VIDEO_ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
]);
const DOCUMENT_ACCEPT =
  ".txt,.csv,.json,.pdf,.docx,text/plain,text/csv,application/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const VIDEO_ACCEPT =
  "video/mp4,video/quicktime,video/x-msvideo,video/x-matroska,.mp4,.mov,.avi,.mkv";

type TranscriptPayload = {
  text: string;
  language: string | null;
  duration: number | null;
  segments: Array<{
    index: number;
    start: number | null;
    end: number | null;
    text: string;
  }>;
};

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });

const formatFileSizeMb = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
  });
  const result = await response.json();
  return { response, result };
}

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [uploadingDocuments, setUploadingDocuments] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [videoUploadId, setVideoUploadId] = useState<string | null>(null);
  const [videoStatus, setVideoStatus] = useState<string | null>(null);
  const [videoTranscript, setVideoTranscript] =
    useState<TranscriptPayload | null>(null);
  const [videoTranscriptError, setVideoTranscriptError] = useState<string | null>(
    null,
  );
  const { showAlert } = useAlert();

  const validateFileTypes = (selectedFiles: File[]) => {
    const invalidFiles = selectedFiles.filter(
      (file) => !DOCUMENT_ALLOWED_TYPES.has(file.type),
    );

    if (invalidFiles.length > 0) {
      const invalidNames = invalidFiles.map((file) => file.name).join(", ");
      showAlert(`Unsupported file type: ${invalidNames}`, "error");
      return false;
    }

    return true;
  };

  const resetVideoResultState = () => {
    setVideoTranscript(null);
    setVideoUploadId(null);
    setVideoStatus(null);
    setVideoTranscriptError(null);
  };

  const uploadFile = async () => {
    if (files.length === 0) {
      showAlert("Please select at least one file to upload", "error");
      return;
    }

    if (!validateFileTypes(files)) {
      return;
    }

    try {
      setUploadingDocuments(true);
      const payloadFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
          base64: await toBase64(file),
        })),
      );

      const { response, result } = await fetchJson(`${API_BASE}/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: payloadFiles,
        }),
      });

      if (!response.ok) {
        showAlert(result.error || "Upload failed", "error");
        return;
      }

      showAlert(
        `Upload successful: processed ${result.filesProcessed} file(s), added ${result.added} record(s)`,
        "success",
      );
    } catch {
      showAlert("Upload failed", "error");
    } finally {
      setUploadingDocuments(false);
    }
  };

  const fetchVideoStatus = async (id: string): Promise<string | null> => {
    try {
      const { response, result } = await fetchJson(
        `${API_BASE}/upload/video/${id}/status`,
      );

      if (!response.ok) {
        const errorMessage = result.error || "Could not fetch video status";
        setVideoTranscriptError(errorMessage);
        showAlert(errorMessage, "error");
        return null;
      }

      const nextStatus = String(result.status || "unknown");
      setVideoStatus(nextStatus);
      if (result.error && nextStatus === "failed") {
        setVideoTranscriptError(String(result.error));
      }
      return nextStatus;
    } catch {
      setVideoTranscriptError("Network error while checking video status");
      return null;
    }
  };

  const fetchVideoTranscript = async (id: string) => {
    try {
      const { response, result } = await fetchJson(
        `${API_BASE}/upload/video/${id}/transcript`,
      );

      if (!response.ok) {
        const errorMessage = result.error || "Could not fetch transcript";
        setVideoTranscriptError(errorMessage);
        if (response.status !== 409) {
          showAlert(errorMessage, "error");
        }
        return;
      }

      setVideoTranscript(result.transcript || null);
      setVideoTranscriptError(null);
      showAlert("Video transcript is ready", "success");
    } catch {
      setVideoTranscriptError("Network error while fetching transcript");
    }
  };

  const uploadVideo = async () => {
    if (!videoFile) {
      showAlert("Please select a video file to upload", "error");
      return;
    }

    if (!VIDEO_ALLOWED_TYPES.has(videoFile.type)) {
      showAlert(`Unsupported video type: ${videoFile.name}`, "error");
      return;
    }

    try {
      setUploadingVideo(true);
      setVideoTranscript(null);
      setVideoTranscriptError(null);
      setVideoStatus("uploading");

      const { response, result } = await fetchJson(`${API_BASE}/upload/video`, {
        method: "POST",
        headers: {
          "Content-Type": videoFile.type,
          "x-file-name": encodeURIComponent(videoFile.name),
        },
        body: videoFile,
      });

      if (!response.ok) {
        showAlert(result.error || "Video upload failed", "error");
        setVideoStatus("failed");
        return;
      }

      const id = String(result.id || "");
      if (!id) {
        showAlert("Upload succeeded but no video id was returned", "error");
        setVideoStatus("failed");
        return;
      }

      setVideoUploadId(id);
      setVideoStatus(String(result.status || "uploaded"));
      showAlert("Video uploaded. Transcription has started.", "success");
    } catch {
      setVideoStatus("failed");
      showAlert("Video upload failed", "error");
    } finally {
      setUploadingVideo(false);
    }
  };

  useEffect(() => {
    if (!videoUploadId) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const status = await fetchVideoStatus(videoUploadId);
      if (!status || cancelled) {
        return;
      }

      if (status === "completed") {
        await fetchVideoTranscript(videoUploadId);
      }
    };

    void poll();

    const intervalId = setInterval(() => {
      if (videoStatus === "completed" || videoStatus === "failed") {
        return;
      }

      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [videoUploadId, videoStatus]);

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-2">
        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Uploads
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">
            Upload Files
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            Add county documents for search and retrieval.
          </p>

          <form className="mt-6 space-y-4">
            <input
              type="file"
              multiple
              accept={DOCUMENT_ACCEPT}
              className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-black shadow-sm transition file:mr-4 file:rounded-full file:border-0 file:bg-slate-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:border-slate-400"
              onChange={(e) => {
                const selectedFiles = e.target.files
                  ? Array.from(e.target.files)
                  : [];
                setFiles(selectedFiles);
                if (selectedFiles.length > 0) {
                  void validateFileTypes(selectedFiles);
                }
              }}
            />

            {files.length > 0 && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="mb-2 text-sm font-semibold text-slate-700">
                  Selected Files ({files.length})
                </p>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-slate-600">
                  {files.map((file) => (
                    <li
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className="truncate"
                    >
                      {file.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </form>

          <button
            onClick={uploadFile}
            disabled={uploadingDocuments}
            className="mt-6 w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
          >
            {uploadingDocuments ? "Uploading..." : "Upload Files"}
          </button>
        </div>

        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Video + Whisper
          </p>
          <h2 className="mt-2 text-3xl font-semibold text-slate-900">
            Upload Video
          </h2>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            Upload a county meeting video to transcribe and index with Whisper.
          </p>

          <div className="mt-6 space-y-4">
            <input
              type="file"
              accept={VIDEO_ACCEPT}
              className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-black shadow-sm transition file:mr-4 file:rounded-full file:border-0 file:bg-slate-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:border-slate-400"
              onChange={(e) => {
                const selected = e.target.files?.[0] || null;
                setVideoFile(selected);
                resetVideoResultState();
              }}
            />

            {videoFile && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-semibold">Selected Video</p>
                <p className="mt-1 truncate">{videoFile.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatFileSizeMb(videoFile.size)}
                </p>
              </div>
            )}

            {videoUploadId && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  <span className="font-semibold">Video ID:</span> {videoUploadId}
                </p>
                <p className="mt-1">
                  <span className="font-semibold">Status:</span>{" "}
                  {videoStatus || "pending"}
                </p>
                {videoTranscriptError && (
                  <p className="mt-2 text-red-700">{videoTranscriptError}</p>
                )}
              </div>
            )}

            {videoTranscript?.text && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-semibold">Transcript Preview</p>
                <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-600">
                  {videoTranscript.text}
                </p>
              </div>
            )}
          </div>

          <button
            onClick={uploadVideo}
            disabled={uploadingVideo}
            className="mt-6 w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
          >
            {uploadingVideo ? "Uploading Video..." : "Upload Video"}
          </button>
        </div>
      </section>
    </main>
  );
}
