"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

const API_BASE_RAW =
    process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
    API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
        ? API_BASE_RAW
        : "http://localhost:1337";

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={<ResetPasswordFallback />}>
            <ResetPasswordForm />
        </Suspense>
    );
}

function ResetPasswordFallback() {
    return (
        <main className="min-h-[calc(100vh-5rem)] bg-[#050b16] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-md">
                <div className="rounded-2xl border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
                        Account Recovery
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-50">
                        Reset Password
                    </h1>
                    <div className="mt-6 h-12 animate-pulse rounded border border-white/10 bg-slate-800/60" />
                    <div className="mt-4 h-12 animate-pulse rounded border border-white/10 bg-slate-800/60" />
                    <div className="mt-4 h-12 animate-pulse rounded border border-sky-300/30 bg-sky-500/10" />
                </div>
            </section>
        </main>
    );
}

function ResetPasswordForm() {
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const searchParams = useSearchParams();
    const router = useRouter();
    const { showAlert } = useAlert();

    const token = useMemo(() => {
        return String(searchParams.get("token") || "").trim();
    }, [searchParams]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!token) {
            showAlert("Reset token is missing or invalid", "error");
            return;
        }

        if (!newPassword || !confirmPassword) {
            showAlert("Please fill in both password fields", "error");
            return;
        }

        if (newPassword.length < 10) {
            showAlert("New password must be at least 10 characters", "error");
            return;
        }

        if (newPassword !== confirmPassword) {
            showAlert("New password and confirm password do not match", "error");
            return;
        }

        setSubmitting(true);
        try {
            const response = await fetch(`${API_BASE}/account/password/reset`, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    token,
                    newPassword,
                }),
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                showAlert(payload?.error || "Unable to reset password", "error");
                return;
            }

            showAlert("Password reset successful. Please log in.", "success");
            router.replace("/account/login");
            router.refresh();
        } catch {
            showAlert("Unable to reset password right now", "error");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <main className="min-h-[calc(100vh-5rem)] bg-[#050b16] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-md">
                <div className="rounded-2xl border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
                        Account Recovery
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-50">
                        Reset Password
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-300">
                        Enter a new password to finish recovering your account.
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                        <input
                            type="password"
                            placeholder="New password (minimum 10 characters)"
                            value={newPassword}
                            onChange={(event) => setNewPassword(event.target.value)}
                            className="block w-full border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-50 outline-none transition placeholder:text-slate-400 hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
                        />
                        <input
                            type="password"
                            placeholder="Confirm new password"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            className="block w-full border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-50 outline-none transition placeholder:text-slate-400 hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
                        />
                        <button
                            type="submit"
                            disabled={submitting || !token}
                            className="w-full border border-sky-300/50 bg-sky-500/15 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? "Resetting Password..." : "Reset Password"}
                        </button>
                    </form>

                    {!token ? (
                        <p className="mt-4 text-sm font-medium text-red-400">
                            This reset link is invalid. Please request a new link.
                        </p>
                    ) : null}

                    <p className="mt-6 text-center text-sm text-slate-300">
                        Back to{" "}
                        <a
                            href="/account/login"
                            className="font-semibold text-sky-200 hover:text-sky-100"
                        >
                            Login
                        </a>
                    </p>
                </div>
            </section>
        </main>
    );
}
