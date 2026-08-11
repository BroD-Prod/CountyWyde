"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

export default function ResetPasswordPage() {
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
            const response = await fetch("http://localhost:1337/account/password/reset", {
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
            <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
                <section className="mx-auto w-full max-w-md">
                    <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                            Account Recovery
                        </p>
                        <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                            Reset Password
                        </h1>
                        <p className="mt-3 text-sm leading-7 text-slate-500">
                            Enter a new password to finish recovering your account.
                        </p>

                        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                            <input
                                type="password"
                                placeholder="New password (minimum 10 characters)"
                                value={newPassword}
                                onChange={(event) => setNewPassword(event.target.value)}
                                className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                            />
                            <input
                                type="password"
                                placeholder="Confirm new password"
                                value={confirmPassword}
                                onChange={(event) => setConfirmPassword(event.target.value)}
                                className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                            />
                            <button
                                type="submit"
                                disabled={submitting || !token}
                                className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {submitting ? "Resetting Password..." : "Reset Password"}
                            </button>
                        </form>

                        {!token ? (
                            <p className="mt-4 text-sm font-medium text-red-600">
                                This reset link is invalid. Please request a new link.
                            </p>
                        ) : null}

                        <p className="mt-6 text-center text-sm text-slate-500">
                            Back to{" "}
                            <a
                                href="/account/login"
                                className="font-semibold text-slate-700 hover:text-slate-900"
                            >
                                Login
                            </a>
                        </p>
                    </div>
                </section>
            </main>
        );
    }
