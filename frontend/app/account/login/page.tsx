"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const router = useRouter();
  const { showAlert } = useAlert();

  useEffect(() => {
    fetch("http://localhost:1337/account/session", {
      method: "GET",
      credentials: "include",
    })
      .then((res) => {
        if (res.ok) {
          router.replace("/account");
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
      const res = await fetch("http://localhost:1337/account/login", {
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

      router.replace("/account");
      router.refresh();
    } catch {
      showAlert("An error occurred during login", "error");
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
        <p className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-300">
          Checking session...
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-md">
        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Account
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">Login</h1>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            Sign in to search county records and manage uploads.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleLogin}>
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
            />
            <button
              type="submit"
              className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
            >
              Login
            </button>
          </form>

          <h2 className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{" "}
            <a
              href="/contact"
              className="font-semibold text-slate-700 hover:text-slate-900"
            >
              Contact Us
            </a>
          </h2>
        </div>
      </section>
    </main>
  );
}
