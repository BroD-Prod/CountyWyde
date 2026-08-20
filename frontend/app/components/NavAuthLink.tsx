"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const API_BASE_RAW =
  process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE;
const API_BASE =
  API_BASE_RAW && API_BASE_RAW !== "undefined" && API_BASE_RAW !== "null"
    ? API_BASE_RAW
    : "http://localhost:1337";

export default function NavAuthLink() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE}/account/session`, {
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

  const linkClassName =
    "border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100";

  if (checkingSession) {
    return (
      <span className="border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200/80">
        Checking...
      </span>
    );
  }

  return isAuthenticated ? (
    <>
      <Link href="/account" className={linkClassName}>
        Account
      </Link>
      <Link href="/upload" className={linkClassName}>
        Upload
      </Link>
    </>
  ) : (
    <Link href="/account/login" className={linkClassName}>
      Login
    </Link>
  );
}
