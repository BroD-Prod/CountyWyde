"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function NavAuthLink() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    fetch("http://localhost:1337/account/session", {
      method: "GET",
      credentials: "include",
    })
      .then((res) => {
        if (cancelled) return;
        setIsAuthenticated(res.ok);
      })
      .catch(() => {
        if (cancelled) return;
        setIsAuthenticated(false);
      })
      .finally(() => {
        if (cancelled) return;
        setCheckingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (checkingSession) {
    return (
      <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
        Checking...
      </span>
    );
  }

  return isAuthenticated ? (
    <>
      <Link
        href="/account"
        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white"
      >
        Account
      </Link>
      <Link
        href="/upload"
        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white"
      >
        Upload
      </Link>
    </>
  ) : (
    <Link
      href="/account/login"
      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white"
    >
      Sign Up / Login
    </Link>
  );
}
