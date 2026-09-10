"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../components/AlertProvider";

type SessionUser = {
  id: number;
  username: string;
  county: string;
  state?: {
    name: string;
    abbreviation: string;
  };
};

type StateOption = {
  id: number;
  name: string;
  abbreviation: string;
};

const API_BASE_RAW =
  process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
  API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
    ? API_BASE_RAW
    : "http://localhost:1337";

export default function Account() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [states, setStates] = useState<StateOption[]>([]);
  const router = useRouter();
  const { showAlert } = useAlert();

  useEffect(() => {
    fetch(`${API_BASE}/account/session`, {
      method: "GET",
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          router.replace("/account/login");
          return;
        }

        const data = await res.json();
        const sessionUser = data.user as SessionUser;
        setUser(sessionUser);
        setCounty(sessionUser?.county || "");
        setState(sessionUser?.state?.abbreviation || "");
      })
      .catch(() => {
        router.replace("/account/login");
      })
      .finally(() => {
        setCheckingSession(false);
      });

    fetch(`${API_BASE}/states`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.states)) {
          setStates(data.states);
        }
      })
      .catch(() => {
        setStates([]);
      });
  }, [router]);

  async function handleAccountUpdate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!user?.username || !county.trim() || !state.trim()) {
      showAlert("County and state are required", "error");
      return;
    }

    const res = await fetch(
      `${API_BASE}/account/update`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          username: user.username,
          county,
          state,
        }),
      },
    );

    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || "Account update failed", "error");
      return;
    }

    setUser((prev) =>
      prev
        ? {
          ...prev,
          county,
          state: data.state,
        }
        : prev,
    );
    showAlert("Account updated successfully", "success");
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
        <p className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-300">
          Loading account...
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="rounded-3xl border border-sky-300/20 bg-slate-900/40 p-8 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Account
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-100">
            Account Settings
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-400">
            Signed in as{" "}
            <span className="font-semibold text-slate-100">
              {user?.username}
            </span>
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleAccountUpdate}>
            <input
              list="registered-counties"
              placeholder="County"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              className="block w-full rounded-2xl border border-cyan-200/20 bg-[#0b2233] px-4 py-3 text-sm text-slate-100 shadow-sm outline-none transition placeholder-slate-400 hover:border-cyan-200/40 focus:border-cyan-200/70 focus:bg-[#0d2a3d]"
            />
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="block w-full rounded-2xl border border-cyan-200/20 bg-[#0b2233] px-4 py-3 text-sm text-slate-100 shadow-sm outline-none transition hover:border-cyan-200/40 focus:border-cyan-200/70 focus:bg-[#0d2a3d]"
            >
              <option value="">Select State</option>
              {states.map((item) => (
                <option key={item.id} value={item.abbreviation}>
                  {item.name} ({item.abbreviation})
                </option>
              ))}
            </select>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <button
                type="submit"
                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-sky-300/50 bg-sky-500/15 px-4 py-3 font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20"
              >
                Save Changes
              </button>
              <a
                href="/account/change-password"
                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-sky-300/50 bg-sky-500/15 px-4 py-3 font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20"
              >
                Change Password
              </a>
              {/* kept red to signal a destructive action */}
              <a
                href="/account/delete"
                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-red-400/50 bg-red-500/15 px-4 py-3 font-semibold text-red-100 transition hover:border-red-300/80 hover:bg-red-400/20"
              >
                Delete Account
              </a>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
