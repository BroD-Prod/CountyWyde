"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

const API_BASE_RAW =
  process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
  API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
    ? API_BASE_RAW
    : "http://localhost:1337";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const router = useRouter();
  const { showAlert } = useAlert();

  useEffect(() => {
    fetch(`${API_BASE}/account/session`, {
      method: "GET",
      credentials: "include",
    })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const mustChangePassword = Boolean(data?.user?.mustChangePassword);
          router.replace(mustChangePassword ? "/account/change-password" : "/account");
          return;
        }

        setCheckingSession(false);
      })
      .catch(() => {
        setCheckingSession(false);
      });
  }, [router]);

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!username.trim() || !password.trim()) {
      showAlert("Please enter both username and password", "error");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/account/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        showAlert(data.error || "Login failed", "error");
        return;
      }

      if (data.requiresTwoFactor) {
        router.replace("/verify");
        router.refresh();
        return;
      }

      if (data.requiresPasswordChange) {
        router.replace("/account/change-password");
        router.refresh();
        return;
      }

      router.replace("/account");
      router.refresh();
    } catch {
      showAlert("An error occurred during login", "error");
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
        <p className="border border-sky-300/20 bg-slate-950/60 px-5 py-3 text-sm text-slate-200 shadow-[0_0_0_1px_rgba(125,211,252,0.12)]">
          Checking session...
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-md">
        <div className="border border-sky-300/20 bg-slate-900/60 p-8 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
            Account
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-50">Login</h1>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            Sign in to search county records and manage uploads.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleLogin}>
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="block w-full border border-sky-300/20 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 shadow-sm outline-none transition placeholder-slate-400 hover:border-sky-300/40 focus:border-sky-300/60 focus:bg-slate-950/80"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full border border-sky-300/20 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 shadow-sm outline-none transition placeholder-slate-400 hover:border-sky-300/40 focus:border-sky-300/60 focus:bg-slate-950/80"
            />
            <button
              type="submit"
              className="w-full bg-linear-to-r from-sky-600 via-cyan-500 to-sky-700 px-4 py-3 font-semibold text-white shadow-lg shadow-sky-950/20 transition hover:from-sky-500 hover:to-cyan-600"
            >
              Login
            </button>
            <div className="text-center">
              <a
                href="/account/forgot-password"
                className="text-sm font-semibold text-sky-200 transition hover:text-sky-100"
              >
                Forgot password?
              </a>
            </div>
          </form>

          <h2 className="mt-6 text-center text-sm text-slate-300">
            Need access?{" "}
            <a
              href="/contact"
              className="font-semibold text-sky-200 hover:text-sky-100"
            >
              Request access
            </a>
          </h2>
          <p className="mt-2 text-center text-xs leading-6 text-slate-300">
            Accounts are created after manual approval by the team.
          </p>
        </div>
      </section>
    </main>
  );
}
