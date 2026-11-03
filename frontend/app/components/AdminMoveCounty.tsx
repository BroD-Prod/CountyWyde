"use client";
import { FormEvent, useEffect, useState } from "react";
import { useAlert } from "./AlertProvider";

// Admin-page section for moving an account to another county. County users
// can't change their own county (it decides whose documents they manage), so
// this is the only place it happens. Moving an account revokes its API keys.

type AccountResult = {
  id: number;
  username: string;
  county: string;
  approved: boolean;
  isAdmin: boolean;
  stateName: string | null;
  stateAbbreviation: string | null;
};

type StateOption = { id: number; name: string; abbreviation: string };

const inputClass =
  "block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200";

export default function AdminMoveCounty({
  apiBase,
  adminKey,
  onKeyError,
}: {
  apiBase: string;
  adminKey: string;
  onKeyError: () => void;
}) {
  const { showAlert } = useAlert();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<AccountResult[] | null>(null);
  const [states, setStates] = useState<StateOption[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [newCounty, setNewCounty] = useState("");
  const [newState, setNewState] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/states`)
      .then((res) => res.json())
      .then((data) => setStates(Array.isArray(data.states) ? data.states : []))
      .catch(() => setStates([]));
  }, [apiBase]);

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const key = adminKey.trim();
    if (!key) {
      showAlert("Please enter your admin key first.", "error");
      return;
    }
    if (query.trim().length < 2) {
      showAlert("Enter at least 2 characters of an email or county.", "error");
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `${apiBase}/admin/accounts?q=${encodeURIComponent(query.trim())}`,
        { headers: { "X-Admin-Key": key } },
      );
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        onKeyError();
        showAlert("Access denied. Wrong admin key.", "error");
        return;
      }
      if (!res.ok) {
        showAlert(data.error || "Search failed.", "error");
        return;
      }
      setResults(data.accounts || []);
      setEditingId(null);
    } catch {
      showAlert("Search failed.", "error");
    } finally {
      setSearching(false);
    }
  }

  function startEditing(account: AccountResult) {
    setEditingId(account.id);
    setNewCounty(account.county);
    setNewState(account.stateAbbreviation || "");
    setConfirming(false);
  }

  async function move(account: AccountResult) {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/admin/accounts/county`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey.trim() },
        body: JSON.stringify({ id: account.id, county: newCounty.trim(), state: newState }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        onKeyError();
        showAlert("Access denied. Wrong admin key.", "error");
        return;
      }
      if (!res.ok) {
        showAlert(data.error || "Could not move account.", "error");
        return;
      }
      setResults((prev) =>
        (prev || []).map((row) =>
          row.id === account.id
            ? {
              ...row,
              county: data.county,
              stateName: data.state?.name ?? row.stateName,
              stateAbbreviation: data.state?.abbreviation ?? row.stateAbbreviation,
            }
            : row,
        ),
      );
      setEditingId(null);
      setConfirming(false);
      showAlert(data.message || "Account moved.", "success");
    } catch {
      showAlert("Could not move account.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-4xl border border-white/10 bg-white/92 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl">
      <div className="border-b border-slate-200 px-6 py-4 sm:px-8">
        <h2 className="text-lg font-semibold text-slate-900">Move Account to Another County</h2>
        <p className="text-sm text-slate-500">
          County users can&rsquo;t change their own county. Moving an account revokes its API
          keys; monitored websites stay with the old county.
        </p>
      </div>

      <form className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:px-8" onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email or county"
          className={inputClass}
          aria-label="Search accounts"
        />
        <button
          type="submit"
          disabled={searching}
          className="rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-950/20 transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </form>

      {results !== null && results.length === 0 && (
        <div className="px-6 pb-8 text-center text-sm text-slate-500 sm:px-8">
          No accounts match that search.
        </div>
      )}

      {results && results.length > 0 && (
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {results.map((account) => (
            <div key={account.id} className="px-6 py-4 sm:px-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {account.username}
                    {account.isAdmin && (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        admin
                      </span>
                    )}
                    {!account.approved && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        pending
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">
                    {account.county}
                    {account.stateAbbreviation ? `, ${account.stateAbbreviation}` : ""}
                  </p>
                </div>
                {editingId !== account.id && (
                  <button
                    type="button"
                    onClick={() => startEditing(account)}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Change county
                  </button>
                )}
              </div>

              {editingId === account.id && (
                <div className="mt-3 space-y-3 rounded-2xl bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      value={newCounty}
                      onChange={(e) => {
                        setNewCounty(e.target.value);
                        setConfirming(false);
                      }}
                      placeholder="County"
                      className={inputClass}
                      aria-label="New county"
                    />
                    <select
                      value={newState}
                      onChange={(e) => {
                        setNewState(e.target.value);
                        setConfirming(false);
                      }}
                      className={`${inputClass} sm:w-64`}
                      aria-label="New state"
                    >
                      <option value="">Select state</option>
                      {states.map((item) => (
                        <option key={item.id} value={item.abbreviation}>
                          {item.name} ({item.abbreviation})
                        </option>
                      ))}
                    </select>
                  </div>
                  {confirming ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-slate-700">
                        Move {account.username} to {newCounty.trim()}, {newState}? Their API keys
                        will be revoked.
                      </span>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void move(account)}
                        className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-60"
                      >
                        {saving ? "Moving..." : "Confirm move"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white"
                      >
                        Back
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!newCounty.trim() || !newState}
                        onClick={() => setConfirming(true)}
                        className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Move account
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
