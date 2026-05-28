"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

export default function DeleteAccount() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const router = useRouter();
  const { showAlert } = useAlert();

  function handleDeleteAccount() {
    if (!username.trim() || !password.trim()) {
      showAlert(
        "Please enter your username & password to delete your account",
        "error",
      );
      return;
    }
    fetch("http://localhost:1337/account/delete", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          showAlert(data.error, "error");
          return;
        }
        showAlert("Account deleted successfully", "success");
        router.replace("/");
      })
      .catch(() => {
        showAlert("An error occurred during account deletion", "error");
      });
  }
  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-lg">
        <div className="rounded-4xl border border-red-200/60 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-red-500">
            Danger Zone
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">
            Delete Account
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            This permanently removes your account after confirming your
            credentials.
          </p>

          <div className="mt-6 space-y-4">
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-200"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-red-500 focus:ring-2 focus:ring-red-200"
            />
            <button
              onClick={handleDeleteAccount}
              className="w-full rounded-2xl bg-linear-to-r from-red-600 to-rose-500 px-4 py-3 font-semibold text-white shadow-lg shadow-red-500/20 transition hover:from-red-500 hover:to-rose-400"
            >
              Delete Account
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
