"use client";
import { useEffect, useState } from "react";
import { useAlert } from "./components/AlertProvider";
import Loading from "./components/Loading";

type SearchSource = {
  id: string;
  source: string;
  documentId?: string | null;
  originalFileName?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  chunkCount?: number | null;
  citationId?: number | null;
  score?: number | null;
  excerpt?: string | null;
};

function isPdfSource(source: SearchSource): boolean {
  const name = String(source.originalFileName || source.source || "")
    .trim()
    .toLowerCase();
  return name.endsWith(".pdf");
}

export default function Home() {
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

  useEffect(() => {
    if (!state) {
      setCounties([]);
      setCounty("");
      return;
    }

    fetch(`http://localhost:1337/counties?state=${encodeURIComponent(state)}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.counties)) {
          setCounties(data.counties);
        }
      })
      .catch(() => {
        setCounties([]);
      });
  }, [state]);

  useEffect(() => {
    fetch("http://localhost:1337/states")
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
      const response = await fetch("http://localhost:1337/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: search, county, state }),
      });

      const result = await response.json();
      if (!response.ok) {
        showAlert(result.error || "Search failed", "error");
        return;
      }

      const parsedSources: SearchSource[] = Array.isArray(result.sources)
        ? result.sources.map((s: SearchSource) => ({
          id: String(s.id || ""),
          source: String(s.source || "Unknown source"),
          documentId: s.documentId ? String(s.documentId) : null,
          originalFileName: s.originalFileName
            ? String(s.originalFileName)
            : null,
          chunkId: s.chunkId ? String(s.chunkId) : null,
          chunkIndex:
            typeof s.chunkIndex === "number" ? Number(s.chunkIndex) : null,
          chunkCount:
            typeof s.chunkCount === "number" ? Number(s.chunkCount) : null,
          citationId:
            typeof s.citationId === "number" ? Number(s.citationId) : null,
          score: typeof s.score === "number" ? Number(s.score) : null,
          excerpt: s.excerpt ? String(s.excerpt) : null,
        }))
        : [];

      setResult(String(result.result || ""));
      setSources(parsedSources);
    } catch {
      showAlert("Search failed", "error");
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="overflow-hidden rounded-4xl border border-white/10 bg-white/92 p-6 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-linear-to-r from-slate-700 via-slate-500 to-slate-700" />
          <div className="mb-6">
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">
              Search CountyWyde
            </h2>
          </div>

          <div className="space-y-4">
            <select
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
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
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
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
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition placeholder-slate-400 hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
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
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
              onClick={handleSearch}
              disabled={isSearching}
            >
              {isSearching ? <Loading inline label="Searching..." /> : "Search"}
            </button>
          </div>

          {result && (
            <div className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left text-sm leading-6 text-slate-800 shadow-sm">
              <p className="font-semibold text-slate-700">Result:</p>
              <p className="whitespace-pre-wrap">{result}</p>

              <div className="space-y-3">
                <p className="font-semibold text-slate-700">Sources:</p>
                {sources.length === 0 && <p>none</p>}

                {sources.map((source) => {
                  const canPreview = isPdfSource(source);
                  const previewSrc = source.documentId
                    ? `http://localhost:1337/documents/${encodeURIComponent(source.documentId)}/original`
                    : `http://localhost:1337/documents/original?source=${encodeURIComponent(source.source)}&county=${encodeURIComponent(county)}&state=${encodeURIComponent(state)}`;

                  return (
                    <div
                      key={`${source.id}-${source.source}`}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-700">
                          {source.source}
                        </p>
                        {(typeof source.chunkIndex === "number" || typeof source.citationId === "number") && (
                          <p className="text-xs text-slate-500">
                            {typeof source.citationId === "number" ? `Citation ${source.citationId}` : ""}
                            {typeof source.chunkIndex === "number"
                              ? `${typeof source.citationId === "number" ? " • " : ""}Chunk ${source.chunkIndex + 1}${typeof source.chunkCount === "number" ? `/${source.chunkCount}` : ""}`
                              : ""}
                          </p>
                        )}
                        {canPreview && (
                          <button
                            type="button"
                            onClick={() => window.open(previewSrc, "_blank", "noopener,noreferrer")}
                            className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600"
                          >
                            Open PDF
                          </button>
                        )}
                      </div>

                      {!canPreview && (
                        <p className="mt-2 text-xs text-slate-500">
                          PDF preview unavailable for this source.
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
