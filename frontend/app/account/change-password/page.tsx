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
            <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-[#050b16] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
                <p className="border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-300">
                    Checking session...
                </p>
            </main>
        );
    }

    return (
        <main className="min-h-[calc(100vh-5rem)] bg-[#050b16] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-md">
                <div className="rounded-2xl border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
                        {mustChangePassword ? "First Login" : "Account"}
                    </p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-50">
                        {mustChangePassword ? "Change Temporary Password" : "Change Password"}
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-300">
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
                            className="block w-full border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-50 outline-none transition placeholder:text-slate-400 hover:border-sky-300/40 focus:border-sky-300/80 focus:bg-slate-950/80 focus:shadow-[0_0_0_1px_rgba(125,211,252,0.5)]"
                        />
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
                            disabled={submitting}
                            className="w-full border border-sky-300/50 bg-sky-500/15 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:border-sky-200/80 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? "Updating Password..." : "Set New Password"}
                        </button>
                    </form>
                </div>
            </section>
        </main>
    );
}
