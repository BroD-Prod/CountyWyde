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

type StateOption = {
  id: number;
  name: string;
  abbreviation: string;
};

export default function CreateAccount() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const router = useRouter();
  const [registeredCounties, setRegisteredCounties] = useState<string[]>([]);
  const [states, setStates] = useState<StateOption[]>([]);
  const { showAlert } = useAlert();

  useEffect(() => {
    fetch(`${API_BASE}/counties`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.counties)) {
          setRegisteredCounties(data.counties);
        }
      })
      .catch(() => {
        setRegisteredCounties([]);
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
  }, []);

  async function handleCreateAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (
      !username.trim() ||
      !password.trim() ||
      !county.trim() ||
      !state.trim()
    ) {
      showAlert("Please enter username, password, county, and state", "error");
      return;
    }

    const response = await fetch(`${API_BASE}/account/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password, county, state }),
    });

    const result = await response.json();
    if (!response.ok) {
      showAlert(result.error || "Account creation failed", "error");
      return;
    }
    router.replace("/account/login");
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-md">
        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Account
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">
            Create Account
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            Set up your CountyWyde account to upload records.
          </p>

          <form className="mt-6 space-y-4" onSubmit={handleCreateAccount}>
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
            <input
              list="registered-counties"
              placeholder="County"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
            />
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
            >
              <option value="" className="text-black">
                Select State
              </option>
              {states.map((item) => (
                <option key={item.id} value={item.abbreviation}>
                  {item.name} ({item.abbreviation})
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
            >
              Create Account
            </button>
          </form>

          <h2 className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <a
              href="/account/login"
              className="font-semibold text-slate-700 hover:text-slate-900"
            >
              Login
            </a>
          </h2>
        </div>
      </section>
    </main>
  );
}
