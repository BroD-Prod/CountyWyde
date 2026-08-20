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
        <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-md">
                <div className="border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
                        Account Recovery
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-50">
                        Forgot Password
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-300">
                        Enter your account email and we&apos;ll guide you to the next step.
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                        <input
                            type="email"
                            placeholder="Email address"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className="block w-full border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-50 outline-none transition placeholder:text-slate-400 hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
                        />
                        <button
                            type="submit"
                            disabled={submitting}
                            className="w-full border border-sky-300/50 bg-sky-500/15 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? "Sending..." : "Send Reset Link"}
                        </button>
                    </form>

                    {process.env.NODE_ENV !== "production" && resetUrl ? (
                        <div className="mt-4 border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                            <p className="font-semibold">Development reset link</p>
                            <a
                                href={resetUrl}
                                className="mt-2 inline-flex break-all font-medium text-emerald-200 underline hover:text-emerald-100"
                            >
                                {resetUrl}
                            </a>
                        </div>
                    ) : null}

                    <div className="mt-6 border border-white/10 bg-slate-950/40 p-4 text-sm leading-6 text-slate-300">
                        <p className="font-semibold text-slate-50">Need immediate access?</p>
                        <p className="mt-1">
                            Contact support and include your full name, county, and state so your identity can be verified.
                        </p>
                        <a
                            href="/contact"
                            className="mt-3 inline-flex font-semibold text-sky-200 transition hover:text-sky-100"
                        >
                            Go to Contact Page
                        </a>
                    </div>

                    <p className="mt-6 text-center text-sm text-slate-300">
                        Remembered your password?{" "}
                        <a
                            href="/account/login"
                            className="font-semibold text-sky-200 hover:text-sky-100"
                        >
                            Back to Login
                        </a>
                    </p>
                </div>
            </section>
        </main>
    );
}
