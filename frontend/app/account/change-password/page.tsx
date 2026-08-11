"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../../components/AlertProvider";

type SessionResponse = {
    user?: {
        username?: string;
        mustChangePassword?: boolean;
    };
};

const API_BASE_RAW =
    process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
    API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
        ? API_BASE_RAW
        : "http://localhost:1337";

export default function ChangePasswordPage() {
    const [checkingSession, setCheckingSession] = useState(true);
    const [username, setUsername] = useState("");
    const [mustChangePassword, setMustChangePassword] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const router = useRouter();
    const { showAlert } = useAlert();

    useEffect(() => {
        fetch(`${API_BASE}/account/session`, {
            method: "GET",
            credentials: "include",
        })
            .then(async (res) => {
                if (!res.ok) {
                    router.replace("/account/login");
                    return;
                }

                const data = (await res.json()) as SessionResponse;
                setMustChangePassword(Boolean(data?.user?.mustChangePassword));
                setUsername(String(data?.user?.username || ""));
            })
            .catch(() => {
                router.replace("/account/login");
            })
            .finally(() => {
                setCheckingSession(false);
            });
    }, [router]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!currentPassword || !newPassword || !confirmPassword) {
            showAlert("All password fields are required", "error");
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
            const response = await fetch(`${API_BASE}/account/password`, {
                method: "PATCH",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    currentPassword,
                    newPassword,
                }),
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                showAlert(payload?.error || "Failed to update password", "error");
                return;
            }

            showAlert("Password updated. Redirecting to your account...", "success");
            router.replace("/account");
            router.refresh();
        } catch {
            showAlert("Unable to update password right now", "error");
        } finally {
            setSubmitting(false);
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
                        {mustChangePassword ? "First Login" : "Account"}
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                        {mustChangePassword ? "Change Temporary Password" : "Change Password"}
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                        {username ? `Signed in as ${username}. ` : ""}
                        {mustChangePassword
                            ? "You must set a new password before continuing."
                            : "Update your account password."}
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                        <input
                            type="password"
                            placeholder={mustChangePassword ? "Current temporary password" : "Current password"}
                            value={currentPassword}
                            onChange={(event) => setCurrentPassword(event.target.value)}
                            className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-black shadow-sm outline-none transition placeholder-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
                        />
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
                            disabled={submitting}
                            className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? "Updating Password..." : "Set New Password"}
                        </button>
                    </form>
                </div>
            </section>
        </main>
    );
}
