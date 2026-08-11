"use client";

import { FormEvent, useState } from "react";
import { useAlert } from "../../components/AlertProvider";

const API_BASE_RAW =
    process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
    API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
        ? API_BASE_RAW
        : "http://localhost:1337";

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [resetUrl, setResetUrl] = useState("");
    const { showAlert } = useAlert();

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const normalizedEmail = email.trim().toLowerCase();
        if (!normalizedEmail) {
            showAlert("Please enter your account email", "error");
            return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            showAlert("Please enter a valid email address", "error");
            return;
        }

        setResetUrl("");
        setSubmitting(true);
        try {
            const response = await fetch(`${API_BASE}/account/password/forgot`, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email: normalizedEmail }),
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                showAlert(payload?.error || "Unable to process request right now", "error");
                return;
            }

            if (typeof payload?.resetUrl === "string" && payload.resetUrl.trim()) {
                setResetUrl(payload.resetUrl.trim());
            }

            showAlert(
                payload?.message ||
                "If this email exists, a password reset link has been sent.",
                "success",
            );
        } catch {
            showAlert("Unable to process request right now", "error");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-md">
                <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Account Recovery
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                        Forgot Password
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                        Enter your account email and we&apos;ll guide you to the next step.
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                        <input
                            type="email"
                            placeholder="Email address"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                        />
                        <button
                            type="submit"
                            disabled={submitting}
                            className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
                        >
                            {submitting ? "Sending..." : "Send Reset Link"}
                        </button>
                    </form>

                    {process.env.NODE_ENV !== "production" && resetUrl ? (
                        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                            <p className="font-semibold">Development reset link</p>
                            <a
                                href={resetUrl}
                                className="mt-2 inline-flex break-all font-medium text-emerald-800 underline hover:text-emerald-950"
                            >
                                {resetUrl}
                            </a>
                        </div>
                    ) : null}

                    <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                        <p className="font-semibold text-slate-900">Need immediate access?</p>
                        <p className="mt-1">
                            Contact support and include your full name, county, and state so your identity can be verified.
                        </p>
                        <a
                            href="/contact"
                            className="mt-3 inline-flex font-semibold text-slate-800 transition hover:text-slate-950"
                        >
                            Go to Contact Page
                        </a>
                    </div>

                    <p className="mt-6 text-center text-sm text-slate-500">
                        Remembered your password?{" "}
                        <a
                            href="/account/login"
                            className="font-semibold text-slate-700 hover:text-slate-900"
                        >
                            Back to Login
                        </a>
                    </p>
                </div>
            </section>
        </main>
    );
}
