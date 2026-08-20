"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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

export default function Contact() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [notes, setNotes] = useState("");
  const [states, setStates] = useState<StateOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusType, setStatusType] = useState<"success" | "error" | null>(
    null,
  );

  const canSubmit = useMemo(() => {
    return Boolean(fullName.trim() && email.trim() && county.trim() && state.trim());
  }, [county, email, fullName, state]);

  useEffect(() => {
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setStatusMessage("");
    setStatusType(null);

    try {
      const response = await fetch(`${API_BASE}/account/request-access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fullName,
          email,
          county,
          state,
          notes,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatusType("error");
        setStatusMessage(payload.error || "Unable to submit account request.");
        return;
      }

      setStatusType("success");
      setStatusMessage(
        payload.message ||
        "Request submitted. Your county account request is now pending review.",
      );
      setFullName("");
      setEmail("");
      setCounty("");
      setState("");
      setNotes("");
    } catch {
      setStatusType("error");
      setStatusMessage("Unable to submit account request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
            Contact
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-50">
            County Account Request
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            County teams can request access here. Requests are reviewed by an
            administrator before any account is created or approved.
          </p>
          <p className="mt-2 text-sm leading-7 text-slate-300">
            This form is the only public registration flow. Please use your
            official county information so the request can be verified.
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-200">
                County Contact Name
              </span>
              <input
                type="text"
                name="fullName"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                className="border border-white/10 bg-slate-950/60 px-3 py-2.5 text-slate-50 placeholder:text-slate-400 outline-none transition hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-200">Email</span>
              <input
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                className="border border-white/10 bg-slate-950/60 px-3 py-2.5 text-slate-50 placeholder:text-slate-400 outline-none transition hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-200">County</span>
              <input
                type="text"
                name="county"
                value={county}
                onChange={(event) => setCounty(event.target.value)}
                required
                className="border border-white/10 bg-slate-950/60 px-3 py-2.5 text-slate-50 placeholder:text-slate-400 outline-none transition hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-200">State</span>
              <select
                value={state}
                onChange={(event) => setState(event.target.value)}
                required
                className="border border-white/10 bg-slate-950/60 px-3 py-2.5 text-slate-50 outline-none transition hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
              >
                <option value="" className="bg-slate-900 text-slate-100">Select a state</option>
                {states.map((item) => (
                  <option key={item.id} value={item.abbreviation} className="bg-slate-900 text-slate-100">
                    {item.name} ({item.abbreviation})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-200">
                County Notes (Optional)
              </span>
              <textarea
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                className="border border-white/10 bg-slate-950/60 px-3 py-2.5 text-slate-50 placeholder:text-slate-400 outline-none transition hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
              />
            </label>

            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              className="mt-4 border border-sky-300/50 bg-sky-500/15 px-4 py-2.5 font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Submitting..." : "Request County Access"}
            </button>
          </form>

          <p className="mt-4 text-sm text-slate-300">
            Or call us at <a href="tel:+1234567890" className="text-sky-200 underline">+1 (234) 567-890</a> to discuss the needs for your county directly.
          </p>
          {statusMessage ? (
            <p
              className={`mt-4 text-sm ${statusType === "success" ? "text-emerald-400" : "text-red-400"}`}
            >
              {statusMessage}
            </p>
          ) : null}

          <p className="mt-3 text-sm leading-7 text-slate-300">
            By requesting access, you agree to our{" "}
            <a href="/tos" className="text-sky-200 underline">
              terms and conditions
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
