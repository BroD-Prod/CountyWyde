"use client";

import { FormEvent, useMemo, useState } from "react";

const API_BASE = "http://localhost:1337";

export default function Contact() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusType, setStatusType] = useState<"success" | "error" | null>(
    null,
  );

  const canSubmit = useMemo(() => {
    return Boolean(fullName.trim() && email.trim() && county.trim() && state.trim());
  }, [county, email, fullName, state]);

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
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Contact
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">
            County Account Request
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-500">
            County teams can request access here. Requests are reviewed by an
            administrator before any account is created.
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">Name</span>
              <input
                type="text"
                name="fullName"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:ring focus:ring-slate-500 focus:ring-opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">Email</span>
              <input
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:ring focus:ring-slate-500 focus:ring-opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">County</span>
              <input
                type="text"
                name="county"
                value={county}
                onChange={(event) => setCounty(event.target.value)}
                required
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:ring focus:ring-slate-500 focus:ring-opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">State</span>
              <input
                type="text"
                name="state"
                value={state}
                onChange={(event) => setState(event.target.value)}
                required
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:ring focus:ring-slate-500 focus:ring-opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">
                Notes (Optional)
              </span>
              <textarea
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:ring focus:ring-slate-500 focus:ring-opacity-50"
              />
            </label>

            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              className="mt-4 rounded-lg bg-slate-700 px-4 py-2 text-white hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Submitting..." : "Request Account"}
            </button>
          </form>

          {statusMessage ? (
            <p
              className={`mt-4 text-sm ${statusType === "success" ? "text-emerald-700" : "text-red-600"
                }`}
            >
              {statusMessage}
            </p>
          ) : null}

          <p className="mt-3 text-sm leading-7 text-slate-500">
            By requesting access, you agree to our{" "}
            <a href="/tos" className="text-slate-700 underline">
              terms and conditions
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
