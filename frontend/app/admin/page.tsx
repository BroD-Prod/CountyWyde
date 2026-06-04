"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAlert } from "../components/AlertProvider";

type PendingAccount = {
  id: number;
  username: string;
  county: string;
  state_name: string;
  state_abbreviation: string;
};

type BlockedIp = {
  ip: string;
  reason: string;
  blockedUntil: number;
  createdAt: number;
};

type SuspiciousIp = {
  ip: string;
  score: number;
  resetAt: number;
  updatedAt: number;
};

type RateLimitedIp = {
  ip: string;
  method: string;
  path: string;
  count: number;
  resetAt: number;
  updatedAt: number;
};

type SecurityOverview = {
  blocked: BlockedIp[];
  suspicious: SuspiciousIp[];
  rateLimited: RateLimitedIp[];
};

const ADMIN_KEY_STORAGE = "adminKey";
const API_BASE = "http://localhost:1337";

function escapeIfNeeded(value: unknown): string {
  return String(value ?? "");
}

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState("");
  const [pendingAccounts, setPendingAccounts] = useState<PendingAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [securityOverview, setSecurityOverview] = useState<SecurityOverview>({
    blocked: [],
    suspicious: [],
    rateLimited: [],
  });
  const { showAlert } = useAlert();

  const pendingCount = useMemo(() => pendingAccounts.length, [pendingAccounts]);

  useEffect(() => {
    const savedKey = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (savedKey) {
      setAdminKey(savedKey);
      void (async () => {
        setLoading(true);
        try {
          const response = await fetch(`${API_BASE}/admin/pending`, {
            headers: {
              "X-Admin-Key": savedKey,
            },
          });

          if (response.status === 403) {
            setKeyError(true);
            setPendingAccounts([]);
            showAlert("Access denied. Wrong admin key.", "error");
            return;
          }

          if (!response.ok) {
            showAlert("Failed to load pending accounts.", "error");
            return;
          }

          const data = (await response.json()) as {
            pending?: PendingAccount[];
          };
          setPendingAccounts(Array.isArray(data.pending) ? data.pending : []);
          await loadSecurity(savedKey);
        } catch {
          return;
        } finally {
          setLoading(false);
        }
      })();
    }
  }, []);

  const saveKey = useCallback((value: string) => {
    setAdminKey(value);
    sessionStorage.setItem(ADMIN_KEY_STORAGE, value);
    setKeyError(false);
  }, []);

  const loadPending = useCallback(async () => {
    const key = adminKey.trim();
    if (!key) {
      showAlert("Please enter your admin key first.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/admin/pending`, {
        headers: {
          "X-Admin-Key": key,
        },
      });

      if (response.status === 403) {
        setKeyError(true);
        showAlert("Access denied. Wrong admin key.", "error");
        setPendingAccounts([]);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        showAlert(data.error || "Failed to load pending accounts.", "error");
        return;
      }

      const data = (await response.json()) as { pending?: PendingAccount[] };
      setPendingAccounts(Array.isArray(data.pending) ? data.pending : []);
      setKeyError(false);
      showAlert("Pending accounts loaded.", "success");
      await loadSecurity(key);
    } catch {
      showAlert("Failed to load pending accounts.", "error");
    } finally {
      setLoading(false);
    }
  }, [adminKey, showAlert]);

  const loadSecurity = useCallback(
    async (overrideKey?: string) => {
      const key = (overrideKey || adminKey).trim();
      if (!key) {
        return;
      }

      setSecurityLoading(true);
      try {
        const response = await fetch(`${API_BASE}/admin/security`, {
          headers: {
            "X-Admin-Key": key,
          },
        });

        if (response.status === 403) {
          setKeyError(true);
          return;
        }

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as Partial<SecurityOverview>;
        setSecurityOverview({
          blocked: Array.isArray(data.blocked) ? data.blocked : [],
          suspicious: Array.isArray(data.suspicious) ? data.suspicious : [],
          rateLimited: Array.isArray(data.rateLimited) ? data.rateLimited : [],
        });
      } catch {
        return;
      } finally {
        setSecurityLoading(false);
      }
    },
    [adminKey],
  );

  const clearSecurity = useCallback(
    async (ip?: string) => {
      const key = adminKey.trim();
      if (!key) {
        showAlert("Please enter your admin key first.", "error");
        return;
      }

      setSecurityLoading(true);
      try {
        const response = await fetch(`${API_BASE}/admin/security`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": key,
          },
          body: JSON.stringify(ip ? { ip } : {}),
        });

        const data = await response.json().catch(() => ({}));
        if (response.status === 403) {
          setKeyError(true);
          showAlert("Access denied. Wrong admin key.", "error");
          return;
        }

        if (!response.ok) {
          showAlert(data.error || "Failed to clear security state.", "error");
          return;
        }

        showAlert(
          ip
            ? `Cleared security state for ${ip}.`
            : "Cleared all security state.",
          "success",
        );
        await loadSecurity(key);
      } catch {
        showAlert("Failed to clear security state.", "error");
      } finally {
        setSecurityLoading(false);
      }
    },
    [adminKey, loadSecurity, showAlert],
  );

  const accountAction = useCallback(
    async (
      url: string,
      id: number,
      method: "PATCH" | "DELETE",
      successMessage: string,
      errorMessage: string,
    ) => {
      const key = adminKey.trim();
      if (!key) {
        showAlert("Please enter your admin key first.", "error");
        return;
      }

      setSelectedId(id);
      try {
        const response = await fetch(`${API_BASE}${url}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": key,
          },
          body: JSON.stringify({ id }),
        });

        const data = await response.json().catch(() => ({}));
        if (response.status === 403) {
          setKeyError(true);
          showAlert("Access denied. Wrong admin key.", "error");
          return;
        }

        if (!response.ok) {
          showAlert(data.error || errorMessage, "error");
          return;
        }

        setPendingAccounts((prev) =>
          prev.filter((account) => account.id !== id),
        );
        setKeyError(false);
        showAlert(successMessage, "success");
      } catch {
        showAlert(errorMessage, "error");
      } finally {
        setSelectedId(null);
      }
    },
    [adminKey, showAlert],
  );

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <section className="rounded-4xl border border-white/10 bg-white/92 p-6 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
          <label
            className="mb-2 block text-sm font-medium text-slate-700"
            htmlFor="admin-key-input"
          >
            Admin Key
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="admin-key-input"
              type="password"
              autoComplete="off"
              value={adminKey}
              onChange={(e) => saveKey(e.target.value)}
              placeholder="Enter your admin key"
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
            />
            <button
              type="button"
              onClick={() => void loadPending()}
              disabled={loading}
              className="rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Loading..." : "Load Pending"}
            </button>
          </div>
          {keyError ? (
            <p className="mt-2 text-sm font-medium text-red-600">
              Incorrect admin key.
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              Your key is saved only in this browser tab.
            </p>
          )}
        </section>

        <section className="overflow-hidden rounded-4xl border border-white/10 bg-white/92 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 sm:px-8">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Pending Signups
              </h2>
              <p className="text-sm text-slate-500">
                {pendingCount} account(s) waiting for review
              </p>
            </div>
          </div>

          {pendingAccounts.length === 0 ? (
            <div className="px-6 py-14 text-center text-sm text-slate-500 sm:px-8">
              No pending signups. Enter your admin key and load accounts.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {pendingAccounts.map((account) => (
                <div
                  key={account.id}
                  className="flex flex-col gap-4 px-6 py-5 transition hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:px-8"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-slate-900">
                      {escapeIfNeeded(account.username)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {escapeIfNeeded(account.county)},{" "}
                      {escapeIfNeeded(account.state_abbreviation)} —{" "}
                      {escapeIfNeeded(account.state_name)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={selectedId === account.id}
                      onClick={() =>
                        void accountAction(
                          "/admin/approve",
                          account.id,
                          "PATCH",
                          "Account approved.",
                          "Failed to approve account.",
                        )
                      }
                      className="rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={selectedId === account.id}
                      onClick={() =>
                        void accountAction(
                          "/admin/reject",
                          account.id,
                          "DELETE",
                          "Account rejected and removed.",
                          "Failed to reject account.",
                        )
                      }
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-4xl border border-white/10 bg-white/92 p-6 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Security State
              </h2>
              <p className="text-sm text-slate-500">
                View and clear persisted blocks, suspicion scores, and
                rate-limit buckets.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void loadSecurity()}
                disabled={securityLoading}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {securityLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                type="button"
                onClick={() => void clearSecurity()}
                disabled={securityLoading}
                className="rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Clear All
              </button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Blocked IPs
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                {securityOverview.blocked.length} active
              </p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-xs">
                {securityOverview.blocked.map((item) => (
                  <li
                    key={`blocked-${item.ip}`}
                    className="rounded-xl border border-slate-100 bg-slate-50 p-2"
                  >
                    <p className="font-semibold text-slate-900">{item.ip}</p>
                    <p className="text-slate-500">{item.reason}</p>
                    <button
                      type="button"
                      onClick={() => void clearSecurity(item.ip)}
                      className="mt-1 text-xs font-semibold text-slate-700 underline-offset-2 hover:underline"
                    >
                      Clear IP
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Suspicious IPs
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                {securityOverview.suspicious.length} tracked
              </p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-xs">
                {securityOverview.suspicious.map((item) => (
                  <li
                    key={`suspicious-${item.ip}`}
                    className="rounded-xl border border-slate-100 bg-slate-50 p-2"
                  >
                    <p className="font-semibold text-slate-900">{item.ip}</p>
                    <p className="text-slate-500">Score: {item.score}</p>
                    <button
                      type="button"
                      onClick={() => void clearSecurity(item.ip)}
                      className="mt-1 text-xs font-semibold text-slate-700 underline-offset-2 hover:underline"
                    >
                      Clear IP
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Rate-Limit Buckets
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                {securityOverview.rateLimited.length} active
              </p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-xs">
                {securityOverview.rateLimited.map((item) => (
                  <li
                    key={`rate-${item.ip}-${item.method}-${item.path}`}
                    className="rounded-xl border border-slate-100 bg-slate-50 p-2"
                  >
                    <p className="font-semibold text-slate-900">{item.ip}</p>
                    <p className="text-slate-500">
                      {item.method} {item.path}
                    </p>
                    <p className="text-slate-500">Count: {item.count}</p>
                    <button
                      type="button"
                      onClick={() => void clearSecurity(item.ip)}
                      className="mt-1 text-xs font-semibold text-slate-700 underline-offset-2 hover:underline"
                    >
                      Clear IP
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
