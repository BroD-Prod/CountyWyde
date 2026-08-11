"use client";

import { useEffect, useMemo, useState } from "react";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 45;

function onlyDigits(value: string): string {
    return value.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

export default function VerifyPage() {
    const [code, setCode] = useState<string>("");
    const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
    const [isResending, setIsResending] = useState<boolean>(false);
    const [resendCooldown, setResendCooldown] = useState<number>(0);
    const [error, setError] = useState<string>("");
    const [success, setSuccess] = useState<string>("");

    const apiBase = useMemo<string>(() => {
        return process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:1337";
    }, []);

    useEffect(() => {
        if (resendCooldown <= 0) {
            return;
        }

        const timer = window.setTimeout(() => {
            setResendCooldown((prev) => prev - 1);
        }, 1000);

        return () => window.clearTimeout(timer);
    }, [resendCooldown]);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");
        setSuccess("");

        if (code.length !== OTP_LENGTH) {
            setError("Enter the full 6-digit verification code.");
            return;
        }

        setIsSubmitting(true);
        try {
            const response = await fetch(`${apiBase}/account/2fa/verify`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(payload?.error || "Verification failed. Please try again.");
                return;
            }

            setSuccess("Code verified. Redirecting...");
            window.setTimeout(() => {
                const destination = payload?.requiresPasswordChange
                    ? "/account/change-password"
                    : "/account";
                window.location.href = destination;
            }, 600);
        } catch {
            setError("Unable to verify right now. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleResend() {
        if (resendCooldown > 0) {
            return;
        }

        setError("");
        setSuccess("");
        setIsResending(true);

        try {
            const response = await fetch(`${apiBase}/account/2fa/resend`, {
                method: "POST",
                credentials: "include",
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(payload?.error || "Could not resend code right now.");
                return;
            }

            setSuccess("A new verification code was sent.");
            setResendCooldown(RESEND_COOLDOWN_SECONDS);
        } catch {
            setError("Unable to resend right now. Please try again.");
        } finally {
            setIsResending(false);
        }
    }

    return (
        <main className="relative min-h-[calc(100vh-5rem)] overflow-hidden bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <div className="pointer-events-none absolute inset-0">
                <div className="absolute -left-20 top-10 h-64 w-64 rounded-full bg-cyan-500/15 blur-3xl" />
                <div className="absolute right-0 top-1/3 h-72 w-72 rounded-full bg-teal-400/10 blur-3xl" />
                <div className="absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-sky-500/10 blur-3xl" />
            </div>

            <section className="relative mx-auto w-full max-w-xl">
                <div className="rounded-4xl border border-white/10 bg-white/90 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Secure Access
                    </p>

                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                        Verify Sign-In
                    </h1>

                    <p className="mt-3 text-sm leading-7 text-slate-600">
                        Enter the 6-digit code sent to your county account email address.
                    </p>

                    <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
                        <div>
                            <label
                                htmlFor="otp-code"
                                className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
                            >
                                Verification Code
                            </label>
                            <input
                                id="otp-code"
                                name="otp-code"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="000000"
                                value={code}
                                onChange={(event) => setCode(onlyDigits(event.target.value))}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-4 text-center font-mono text-2xl tracking-[0.35em] text-slate-900 outline-none ring-cyan-400 transition focus:border-cyan-400 focus:ring-2"
                                aria-invalid={error ? "true" : "false"}
                                aria-describedby="otp-feedback"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={isSubmitting || code.length !== OTP_LENGTH}
                            className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isSubmitting ? "Verifying..." : "Verify and Continue"}
                        </button>
                    </form>

                    <div className="mt-5 flex items-center justify-between gap-3">
                        <p id="otp-feedback" className="text-sm text-slate-600">
                            Didn't get a code?
                        </p>
                        <button
                            type="button"
                            onClick={handleResend}
                            disabled={isResending || resendCooldown > 0}
                            className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-700 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isResending
                                ? "Sending..."
                                : resendCooldown > 0
                                    ? `Resend in ${resendCooldown}s`
                                    : "Resend code"}
                        </button>
                    </div>

                    {error ? (
                        <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
                    ) : null}
                    {success ? (
                        <p className="mt-4 text-sm font-medium text-emerald-700">
                            {success}
                        </p>
                    ) : null}
                </div>
            </section>
        </main>
    );
}