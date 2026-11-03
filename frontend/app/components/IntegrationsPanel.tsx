"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAlert } from "./AlertProvider";

// Account-page section for keeping a county's documents in sync automatically.
// Rendered only for signed-in users (the account page redirects otherwise),
// and every backend route behind it also requires an approved county session.

type ApiKey = {
  id: string;
  label: string;
  keyPrefix: string;
  createdBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

type Source = {
  id: string;
  label: string;
  url: string;
  checkIntervalHours: number;
  active: boolean;
  lastCheckedAt: number | null;
  lastStatus: "checking" | "ok" | "warning" | "error" | null;
  lastError: string | null;
  lastNewCount: number;
  documentCount: number;
  createdBy: string | null;
};

type SourceDocument = {
  url: string;
  name: string | null;
  indexed: boolean;
  error: string | null;
  lastIngestedAt: number | null;
};

const INTERVAL_OPTIONS = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 24, label: "Daily" },
  { hours: 168, label: "Weekly" },
];

const inputClass =
  "block w-full rounded-2xl border border-cyan-200/20 bg-[#0b2233] px-4 py-3 text-sm text-slate-100 shadow-sm outline-none transition placeholder-slate-400 hover:border-cyan-200/40 focus:border-cyan-200/70 focus:bg-[#0d2a3d]";
const primaryButton =
  "inline-flex items-center justify-center rounded-2xl border border-sky-300/50 bg-sky-500/15 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50";
const smallButton =
  "rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-sky-200/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-50";
const dangerSmallButton =
  "rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:border-red-300/70 hover:bg-red-400/20";
const cardClass =
  "rounded-3xl border border-sky-300/20 bg-slate-900/40 p-6 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-8";

function timeAgo(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function StatusBadge({ source }: { source: Source }) {
  let label = "Not checked yet";
  let tone = "border-slate-400/30 bg-slate-500/10 text-slate-300";
  if (!source.active) {
    label = "Paused";
  } else if (source.lastStatus === "checking") {
    label = "Checking…";
    tone = "border-sky-300/40 bg-sky-500/10 text-sky-200";
  } else if (source.lastStatus === "ok") {
    label = "Up to date";
    tone = "border-emerald-300/40 bg-emerald-500/10 text-emerald-200";
  } else if (source.lastStatus === "warning" || source.lastStatus === "error") {
    label = "Needs attention";
    tone = "border-amber-300/40 bg-amber-500/10 text-amber-200";
  }
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

export default function IntegrationsPanel({ apiBase }: { apiBase: string }) {
  const { showAlert } = useAlert();
  const [loading, setLoading] = useState(true);
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceInterval, setSourceInterval] = useState(24);
  const [savingSource, setSavingSource] = useState(false);

  const [keyLabel, setKeyLabel] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [openDocs, setOpenDocs] = useState<string | null>(null);
  const [docs, setDocs] = useState<SourceDocument[]>([]);

  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${apiBase}${path}`, {
        credentials: "include",
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    },
    [apiBase],
  );

  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      request("/account/integrations").then(({ res, data }) => {
        if (isCancelled()) return;
        if (res.ok) {
          setCounty(data.county);
          setState(data.state);
          setSources(data.sources || []);
          setApiKeys(data.apiKeys || []);
        }
        setLoading(false);
      }),
    [request],
  );

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // While a check is running, refresh until it finishes.
  const anyChecking = sources.some((s) => s.lastStatus === "checking");
  useEffect(() => {
    if (!anyChecking) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [anyChecking, load]);

  async function addSource(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      showAlert("Paste the link to a page on your website", "error");
      return;
    }
    setSavingSource(true);
    const { res, data } = await request("/account/integrations/sources", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl.trim(),
        label: sourceLabel.trim(),
        checkIntervalHours: sourceInterval,
      }),
    });
    setSavingSource(false);
    if (!res.ok) {
      showAlert(data.error || "Could not add that page", "error");
      return;
    }
    setSourceUrl("");
    setSourceLabel("");
    setSources((prev) => [data.source, ...prev]);
    showAlert("Page added. Checking it for documents now.", "success");
  }

  async function checkNow(source: Source) {
    const { res, data } = await request(`/account/integrations/sources/${source.id}/check`, {
      method: "POST",
    });
    if (!res.ok) {
      showAlert(data.error || "Could not start a check", "error");
      return;
    }
    setSources((prev) => prev.map((s) => (s.id === source.id ? data.source : s)));
  }

  async function updateSource(source: Source, changes: Partial<Pick<Source, "active" | "checkIntervalHours">>) {
    const { res, data } = await request(`/account/integrations/sources/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    if (!res.ok) {
      showAlert(data.error || "Could not update", "error");
      return;
    }
    setSources((prev) => prev.map((s) => (s.id === source.id ? data.source : s)));
  }

  async function removeSource(source: Source) {
    const { res, data } = await request(`/account/integrations/sources/${source.id}`, {
      method: "DELETE",
    });
    setConfirming(null);
    if (!res.ok) {
      showAlert(data.error || "Could not remove", "error");
      return;
    }
    setSources((prev) => prev.filter((s) => s.id !== source.id));
    showAlert("Stopped monitoring. Documents already added stay searchable.", "success");
  }

  async function toggleDocs(source: Source) {
    if (openDocs === source.id) {
      setOpenDocs(null);
      return;
    }
    const { res, data } = await request(`/account/integrations/sources/${source.id}/documents`);
    if (res.ok) {
      setDocs(data.documents || []);
      setOpenDocs(source.id);
    }
  }

  async function createKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!keyLabel.trim()) {
      showAlert("Give the key a name so you can recognize it later", "error");
      return;
    }
    setCreatingKey(true);
    const { res, data } = await request("/account/integrations/api-keys", {
      method: "POST",
      body: JSON.stringify({ label: keyLabel.trim() }),
    });
    setCreatingKey(false);
    if (!res.ok) {
      showAlert(data.error || "Could not create key", "error");
      return;
    }
    setKeyLabel("");
    setNewKey(data.key);
    setApiKeys((prev) => [data.apiKey, ...prev]);
  }

  async function revokeKey(key: ApiKey) {
    const { res, data } = await request(`/account/integrations/api-keys/${key.id}`, {
      method: "DELETE",
    });
    setConfirming(null);
    if (!res.ok) {
      showAlert(data.error || "Could not revoke key", "error");
      return;
    }
    setApiKeys((prev) => prev.filter((k) => k.id !== key.id));
    showAlert("Key revoked. Anything using it will stop working.", "success");
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      showAlert("Key copied", "success");
    } catch {
      showAlert("Select the key and copy it manually", "info");
    }
  }

  if (loading) {
    return (
      <div className={cardClass}>
        <p className="text-sm text-slate-400">Loading integrations…</p>
      </div>
    );
  }

  const curlExample = `curl -X POST ${apiBase}/api/v1/documents \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://yourcounty.gov/files/agenda.pdf"}'`;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          Integrations
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-100">
          Keep documents up to date automatically
        </h2>
        <p className="mt-2 text-sm leading-7 text-slate-400">
          Connect {county ? `${county}, ${state}'s` : "your county's"} website so new
          documents become searchable without uploading them by hand. Everyone with an
          account in your county can see and manage these settings.
        </p>
      </div>

      {/* --- No-code option --- */}
      <section className={cardClass}>
        <h3 className="text-lg font-semibold text-slate-100">Monitor your website</h3>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          No technical setup needed. Paste the link to a page that lists your documents
          (for example, &ldquo;Agendas &amp; Minutes&rdquo;), an RSS feed, or a sitemap.
          We&rsquo;ll check it on a schedule and add any new or updated PDF, Word, CSV, or
          text files.
        </p>

        <form className="mt-5 space-y-3" onSubmit={addSource}>
          <input
            type="url"
            inputMode="url"
            placeholder="https://yourcounty.gov/agendas"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            className={inputClass}
          />
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              placeholder="Name (optional), e.g. Board agendas"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              className={inputClass}
            />
            <select
              value={sourceInterval}
              onChange={(e) => setSourceInterval(Number(e.target.value))}
              className={`${inputClass} sm:w-48`}
              aria-label="How often to check"
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={savingSource} className={`${primaryButton} w-full`}>
            {savingSource ? "Adding…" : "Start monitoring"}
          </button>
        </form>

        {sources.length > 0 && (
          <ul className="mt-6 space-y-3">
            {sources.map((source) => (
              <li key={source.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-100">{source.label}</p>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-xs text-sky-300 hover:underline"
                    >
                      {source.url}
                    </a>
                  </div>
                  <StatusBadge source={source} />
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  {source.documentCount} document{source.documentCount === 1 ? "" : "s"} added
                  {" · "}last checked {timeAgo(source.lastCheckedAt)}
                  {source.lastStatus === "ok" && source.lastNewCount > 0
                    ? ` · ${source.lastNewCount} new or updated last time`
                    : ""}
                </p>
                {source.lastError && source.lastStatus !== "checking" && (
                  <p className="mt-2 rounded-xl border border-amber-300/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    {source.lastError}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={smallButton}
                    disabled={source.lastStatus === "checking"}
                    onClick={() => checkNow(source)}
                  >
                    Check now
                  </button>
                  <select
                    value={source.checkIntervalHours}
                    onChange={(e) => updateSource(source, { checkIntervalHours: Number(e.target.value) })}
                    className="rounded-xl border border-white/15 bg-[#0b2233] px-2 py-1.5 text-xs text-slate-200"
                    aria-label="How often to check"
                  >
                    {INTERVAL_OPTIONS.map((option) => (
                      <option key={option.hours} value={option.hours}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() => updateSource(source, { active: !source.active })}
                  >
                    {source.active ? "Pause" : "Resume"}
                  </button>
                  <button type="button" className={smallButton} onClick={() => toggleDocs(source)}>
                    {openDocs === source.id ? "Hide files" : "View files"}
                  </button>
                  {confirming === `source-${source.id}` ? (
                    <>
                      <span className="text-xs text-slate-300">Stop monitoring?</span>
                      <button type="button" className={dangerSmallButton} onClick={() => removeSource(source)}>
                        Yes, remove
                      </button>
                      <button type="button" className={smallButton} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={dangerSmallButton}
                      onClick={() => setConfirming(`source-${source.id}`)}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {openDocs === source.id && (
                  <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40">
                    {docs.length === 0 ? (
                      <p className="p-3 text-xs text-slate-400">No files found yet.</p>
                    ) : (
                      <ul className="divide-y divide-white/5">
                        {docs.map((doc) => (
                          <li key={doc.url} className="flex items-start justify-between gap-3 p-3 text-xs">
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 truncate text-slate-200 hover:underline"
                            >
                              {doc.name || doc.url}
                            </a>
                            <span
                              className={`shrink-0 ${doc.indexed ? "text-emerald-300" : "text-amber-300"}`}
                              title={doc.error || undefined}
                            >
                              {doc.indexed
                                ? `Added ${timeAgo(doc.lastIngestedAt)}`
                                : (doc.error || "Pending").replace(/^skipped: /, "Skipped: ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Developer option --- */}
      <section className={cardClass}>
        <h3 className="text-lg font-semibold text-slate-100">Developer API</h3>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          For counties with a web team. Have your website or document system send files to
          CountyWyde the moment they&rsquo;re published. Use these keys only on your servers,
          never in browser code.
        </p>

        {newKey && (
          <div className="mt-5 rounded-2xl border border-emerald-300/30 bg-emerald-500/10 p-4">
            <p className="text-sm font-semibold text-emerald-100">
              Copy your new key now. You won&rsquo;t be able to see it again.
            </p>
            <code className="mt-2 block break-all rounded-xl bg-slate-950/60 px-3 py-2 text-xs text-emerald-50">
              {newKey}
            </code>
            <div className="mt-3 flex gap-2">
              <button type="button" className={smallButton} onClick={copyKey}>
                Copy
              </button>
              <button type="button" className={smallButton} onClick={() => setNewKey(null)}>
                I&rsquo;ve saved it
              </button>
            </div>
          </div>
        )}

        <form className="mt-5 flex flex-col gap-3 sm:flex-row" onSubmit={createKey}>
          <input
            placeholder="Key name, e.g. County website CMS"
            value={keyLabel}
            onChange={(e) => setKeyLabel(e.target.value)}
            className={inputClass}
          />
          <button type="submit" disabled={creatingKey} className={`${primaryButton} sm:w-48`}>
            {creatingKey ? "Creating…" : "Create API key"}
          </button>
        </form>

        {apiKeys.length > 0 && (
          <ul className="mt-5 space-y-2">
            {apiKeys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-100">{key.label}</p>
                  <p className="text-xs text-slate-400">
                    <code>{key.keyPrefix}…</code>
                    {key.createdBy ? ` · created by ${key.createdBy}` : ""}
                    {` · last used ${timeAgo(key.lastUsedAt)}`}
                  </p>
                </div>
                {confirming === `key-${key.id}` ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-300">Revoke this key?</span>
                    <button type="button" className={dangerSmallButton} onClick={() => revokeKey(key)}>
                      Revoke
                    </button>
                    <button type="button" className={smallButton} onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={dangerSmallButton}
                    onClick={() => setConfirming(`key-${key.id}`)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <details className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
          <summary className="cursor-pointer font-semibold text-slate-100">Quick start</summary>
          <p className="mt-3 text-xs leading-6 text-slate-400">
            Send a link to the file and we&rsquo;ll fetch it, or send the file itself as
            base64 with <code>{"{ name, type, base64 }"}</code>. Sending a file with the same
            name again replaces the old version. Use <code>GET</code> to list your documents
            and <code>DELETE ?name=…</code> to remove one.
          </p>
          <div className="mt-3 overflow-x-auto rounded-xl bg-slate-950/60 p-3">
            <pre className="text-xs text-slate-200">{curlExample}</pre>
          </div>
        </details>
      </section>
    </div>
  );
}
