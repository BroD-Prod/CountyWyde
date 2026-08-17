"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAlert } from "./components/AlertProvider";
import Loading from "./components/Loading";

type SearchSource = {
  id: string;
  source: string;
  documentId?: string | null;
  originalFileName?: string | null;
  parsedType?: string | null;
  videoId?: string | null;
  timestamp?: string | null;
  timestampSeconds?: number | null;
  transcriptSnippet?: string | null;
  transcriptSegments?: Array<{ start?: number | null; text?: string | null }>;
  excerpt?: string | null;
};

function isPdfSource(source: SearchSource): boolean {
  const name = String(source.originalFileName || source.source || "")
    .trim()
    .toLowerCase();
  return name.endsWith(".pdf");
}

function isVideoSource(source: SearchSource): boolean {
  const name = String(source.originalFileName || source.source || "")
    .trim()
    .toLowerCase();
  return (
    source.parsedType === "whisper_transcript" ||
    Boolean(source.videoId) ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(name)
  );
}

function normalizeTimestampSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  // Legacy transcripts can persist milliseconds; normalize for display.
  if (value > 24 * 60 * 60) {
    return value / 1000;
  }

  return value;
}

function formatTimestamp(seconds: number | null | undefined): string {
  if (!Number.isFinite(Number(seconds))) {
    return "Timestamp";
  }

  const totalSeconds = Math.max(
    0,
    Math.floor(normalizeTimestampSeconds(Number(seconds))),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(
      minutes,
    ).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:1337";

export default function Home() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState("");
  const [sources, setSources] = useState<SearchSource[]>([]);
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [counties, setCounties] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [states, setStates] = useState<
    { name: string; abbreviation: string }[]
  >([]);
  const { showAlert } = useAlert();
  const isEmbed = searchParams.get("embed") === "1";

  useEffect(() => {
    const urlState = searchParams.get("state") ?? "";
    const urlCounty = searchParams.get("county") ?? "";

    if (urlState) {
      setState(urlState);
    } else {
      setState("");
    }

    if (urlCounty) {
      setCounty(urlCounty);
    } else if (!urlState) {
      setCounty("");
    }
  }, [searchParams]);

  useEffect(() => {
    if (!state) {
      setCounties([]);
      if (!searchParams.get("county")) {
        setCounty("");
      }
      return;
    }

    fetch(`${API_URL}/counties?state=${encodeURIComponent(state)}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.counties)) {
          setCounties(data.counties);

          const urlCounty = searchParams.get("county") ?? "";
          if (urlCounty && data.counties.includes(urlCounty)) {
            setCounty(urlCounty);
          } else if (!urlCounty) {
            setCounty("");
          }
        }
      })
      .catch(() => {
        setCounties([]);
      });
  }, [state, searchParams]);

  useEffect(() => {
    fetch(`${API_URL}/states`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.states)) {
          setStates(data.states);
        }
      })
      .catch(() => {
        setStates([]);
      });
  }, []);

  const handleSearch = async () => {
    if (!search.trim()) {
      showAlert("Please enter a search query", "error");
      return;
    }

    if (!county) {
      showAlert("Please select a county", "error");
      return;
    }

    if (!state) {
      showAlert("Please select a state", "error");
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch(`${API_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ prompt: search, county, state }),
      });

      const resultData = await response.json();
      if (!response.ok) {
        showAlert(resultData.error || "Search failed", "error");
        return;
      }

      const rawSources: SearchSource[] = Array.isArray(resultData.sources)
        ? resultData.sources.map((s: SearchSource) => ({
          id: String(s.id || ""),
          source: String(s.source || "Unknown source"),
          documentId: s.documentId ? String(s.documentId) : null,
          originalFileName: s.originalFileName
            ? String(s.originalFileName)
            : null,
          parsedType: s.parsedType ? String(s.parsedType) : null,
          videoId: s.videoId ? String(s.videoId) : null,
          timestamp: s.timestamp ? String(s.timestamp) : null,
          timestampSeconds:
            s.timestampSeconds != null ? Number(s.timestampSeconds) : null,
          transcriptSnippet: s.transcriptSnippet
            ? String(s.transcriptSnippet)
            : null,
          transcriptSegments: Array.isArray(s.transcriptSegments)
            ? s.transcriptSegments.map(
              (segment: {
                start?: number | null;
                text?: string | null;
              }) => ({
                start: segment.start != null ? Number(segment.start) : null,
                text: segment.text ? String(segment.text) : null,
              }),
            )
            : [],
          excerpt: s.excerpt ? String(s.excerpt) : null,
        }))
        : [];

      // Group and merge sources strictly by source filename
      const uniqueSourcesMap = new Map<string, SearchSource>();

      for (const item of rawSources) {
        const key = item.source.trim().toLowerCase();

        if (!uniqueSourcesMap.has(key)) {
          uniqueSourcesMap.set(key, { ...item });
        } else {
          const existing = uniqueSourcesMap.get(key)!;

          // Merge fields from secondary records into the primary record
          if (!existing.videoId && item.videoId) {
            existing.videoId = item.videoId;
          }
          if (!existing.documentId && item.documentId) {
            existing.documentId = item.documentId;
          }
          if (!existing.parsedType && item.parsedType) {
            existing.parsedType = item.parsedType;
          }
          if (
            existing.timestampSeconds == null &&
            item.timestampSeconds != null
          ) {
            existing.timestampSeconds = item.timestampSeconds;
          }
          if (!existing.timestamp && item.timestamp) {
            existing.timestamp = item.timestamp;
          }
          if (!existing.transcriptSnippet && item.transcriptSnippet) {
            existing.transcriptSnippet = item.transcriptSnippet;
          }
          if (
            (!existing.transcriptSegments ||
              existing.transcriptSegments.length === 0) &&
            item.transcriptSegments?.length
          ) {
            existing.transcriptSegments = item.transcriptSegments;
          }
          if (!existing.excerpt && item.excerpt) {
            existing.excerpt = item.excerpt;
          }
        }
      }

      setResult(String(resultData.result || ""));
      setSources(Array.from(uniqueSourcesMap.values()));
    } catch {
      showAlert("Search failed", "error");
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <main
      className={
        isEmbed
          ? "min-h-screen bg-white px-3 py-4 text-slate-900"
          : "min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8"
      }
    >
      <section
        className={
          isEmbed ? "mx-auto w-full max-w-md" : "mx-auto w-full max-w-2xl"
        }
      >
        <div
          className={
            isEmbed
              ? "overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              : "overflow-hidden rounded-4xl border border-white/10 bg-white/92 p-6 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8"
          }
        >
          {!isEmbed && (
            <>
              <div className="absolute inset-x-0 top-0 h-1 bg-linear-to-r from-slate-700 via-slate-500 to-slate-700" />
              <div className="mb-6">
                <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                  Search CountyWyde
                </h2>
              </div>
            </>
          )}

          <div className="space-y-4">
            <select
              className={
                isEmbed
                  ? "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                  : "block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              }
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setCounty("");
              }}
            >
              <option value="">Select State</option>
              {states.map((s) => (
                <option key={s.abbreviation} value={s.abbreviation}>
                  {s.name}
                </option>
              ))}
            </select>

            <select
              className={
                isEmbed
                  ? "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100"
                  : "block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              }
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              disabled={!state}
            >
              <option value="">Select County</option>
              {counties.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>

            <input
              className={
                isEmbed
                  ? "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                  : "block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition placeholder-slate-400 hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              }
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearch();
                }
              }}
            />

            <button
              className={
                isEmbed
                  ? "flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
                  : "flex w-full items-center justify-center gap-2 rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
              }
              onClick={handleSearch}
              disabled={isSearching}
            >
              {isSearching ? <Loading inline label="Searching..." /> : "Search"}
            </button>
          </div>

          {!isEmbed && result && (
            <div className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left text-sm leading-6 text-slate-800 shadow-sm">
              <p className="font-semibold text-slate-700">Result:</p>
              <p className="whitespace-pre-wrap">{result}</p>

              <div className="space-y-3">
                <p className="font-semibold text-slate-700">Sources:</p>
                {sources.length === 0 && <p>none</p>}

                {sources.map((source) => {
                  const canPreviewPdf = isPdfSource(source);
                  const isVideo = isVideoSource(source);
                  const canOpenVideo =
                    Boolean(source.videoId) && source.videoId !== "";

                  const transcriptHeaderTimestamp =
                    source.timestampSeconds != null
                      ? formatTimestamp(source.timestampSeconds)
                      : source.timestamp || null;

                  const previewSrc = source.documentId
                    ? `${API_URL}/documents/${encodeURIComponent(
                      source.documentId,
                    )}/original`
                    : `${API_URL}/documents/original?source=${encodeURIComponent(
                      source.source,
                    )}&county=${encodeURIComponent(
                      county,
                    )}&state=${encodeURIComponent(state)}`;

                  const downloadVideoSrc = canOpenVideo
                    ? `${API_URL}/upload/video/${encodeURIComponent(
                      String(source.videoId),
                    )}/original`
                    : "";

                  return (
                    <div
                      key={`${source.id}-${source.source}`}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-700">
                          {source.source}
                        </p>
                        {transcriptHeaderTimestamp && (
                          <details className="group rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                            <summary className="cursor-pointer list-none">
                              Transcript at {transcriptHeaderTimestamp}
                            </summary>
                            <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm font-normal text-slate-700">
                              {source.transcriptSegments?.length ? (
                                <ul className="space-y-2 text-xs text-slate-500">
                                  {source.transcriptSegments.map(
                                    (segment, index) => (
                                      <li
                                        key={`${segment.start ?? index
                                          }-${index}`}
                                      >
                                        <span className="font-semibold text-slate-600">
                                          {formatTimestamp(segment.start)}
                                        </span>{" "}
                                        {segment.text}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              ) : null}
                            </div>
                          </details>
                        )}
                        {canPreviewPdf && (
                          <button
                            type="button"
                            onClick={() =>
                              window.open(
                                previewSrc,
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600"
                          >
                            Open PDF
                          </button>
                        )}
                        {canOpenVideo && (
                          <button
                            type="button"
                            onClick={() =>
                              window.open(
                                downloadVideoSrc,
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-200"
                          >
                            Download Video
                          </button>
                        )}
                      </div>

                      {!canPreviewPdf && !isVideo && (
                        <p className="mt-2 text-xs text-slate-500">
                          Preview unavailable for this source.
                        </p>
                      )}

                      {source.excerpt && (
                        <p className="mt-3 line-clamp-4 text-xs text-slate-600">
                          {source.excerpt}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}