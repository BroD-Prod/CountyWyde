'use client';
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAlert } from "../components/AlertProvider";

type SessionUser = {
    id: number;
    username: string;
    county: string;
    state?: {
        name: string;
        abbreviation: string;
    };
};

type StateOption = {
    id: number;
    name: string;
    abbreviation: string;
};

export default function Account() {
    const [checkingSession, setCheckingSession] = useState(true);
    const [user, setUser] = useState<SessionUser | null>(null);
    const [county, setCounty] = useState('');
    const [state, setState] = useState('');
    const [states, setStates] = useState<StateOption[]>([]);
    const router = useRouter();
    const { showAlert } = useAlert();

    useEffect(() => {
        fetch('http://localhost:1337/account/session', {
            method: 'GET',
            credentials: 'include',
        })
            .then(async (res) => {
                if (!res.ok) {
                    router.replace('/account/login');
                    return;
                }

                const data = await res.json();
                const sessionUser = data.user as SessionUser;
                setUser(sessionUser);
                setCounty(sessionUser?.county || '');
                setState(sessionUser?.state?.abbreviation || '');
            })
            .catch(() => {
                router.replace('/account/login');
            })
            .finally(() => {
                setCheckingSession(false);
            });

        fetch('http://localhost:1337/states')
            .then((res) => res.json())
            .then((data) => {
                if (Array.isArray(data.states)) {
                    setStates(data.states);
                }
            })
            .catch(() => {
                setStates([]);
            });
    }, [router]);

    async function handleAccountUpdate(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (!user?.username || !county.trim() || !state.trim()) {
            showAlert('County and state are required', 'error');
            return;
        }

        const res = await fetch('http://localhost:1337/account/update', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
                username: user.username,
                county,
                state,
            }),
        });

        const data = await res.json();
        if (!res.ok) {
            showAlert(data.error || 'Account update failed', 'error');
            return;
        }

        setUser((prev) => prev ? {
            ...prev,
            county,
            state: data.state,
        } : prev);
        showAlert('Account updated successfully', 'success');
    }

    if (checkingSession) {
        return (
            <main className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
                <p className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-300">Loading account...</p>
            </main>
        );
    }

    return (
        <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-2xl">
                <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Account</p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">Account Settings</h1>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                        Signed in as <span className="font-semibold text-slate-900">{user?.username}</span>
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={handleAccountUpdate}>
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
                            <option value="">Select State</option>
                            {states.map((item) => (
                                <option key={item.id} value={item.abbreviation}>
                                    {item.name} ({item.abbreviation})
                                </option>
                            ))}
                        </select>
                        <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                            <button type="submit" className="inline-flex flex-1 items-center justify-center rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700">
                                Save Changes
                            </button>
                            <a
                                href="/account/delete"
                                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-700 transition hover:bg-red-100"
                            >
                                Delete Account
                            </a>
                        </div>
                    </form>
                </div>
            </section>
        </main>
    )
}   