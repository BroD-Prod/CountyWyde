import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import NavAuthLink from "./components/NavAuthLink";
import AlertProvider from "./components/AlertProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CountyWyde",
  description: "Find Your County's Data, Now!",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-950 text-slate-100">
        <AlertProvider>
          <nav className="sticky top-0 z-40 w-full border-b border-slate-800 bg-slate-950 p-4 text-white">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
              <div className="text-2xl font-bold">CountyWyde</div>
              {/* Desktop Navigation */}
              <div className="hidden items-center gap-3 sm:flex">
                <Link
                  href="/"
                  className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-slate-200 transition hover:bg-slate-700 hover:text-white"
                >
                  Home
                </Link>
                <Link
                  href="/about"
                  className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-slate-200 transition hover:bg-slate-700 hover:text-white"
                >
                  About
                </Link>
                <Link
                  href="/contact"
                  className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-slate-200 transition hover:bg-slate-700 hover:text-white"
                >
                  Contact
                </Link>
                <NavAuthLink />
              </div>

              {/* Mobile Navigation */}
              <details className="relative sm:hidden">
                <summary className="cursor-pointer list-none rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-slate-200 transition hover:bg-slate-700 hover:text-white">
                  Menu
                </summary>
                <div className="absolute right-0 mt-2 flex w-64 flex-col gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-3 shadow-xl">
                  <Link
                    href="/"
                    className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-center text-slate-200 transition hover:bg-slate-700 hover:text-white"
                  >
                    Home
                  </Link>
                  <Link
                    href="/about"
                    className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-center text-slate-200 transition hover:bg-slate-700 hover:text-white"
                  >
                    About
                  </Link>
                  <Link
                    href="/contact"
                    className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-center text-slate-200 transition hover:bg-slate-700 hover:text-white"
                  >
                    Contact
                  </Link>
                  <div className="flex flex-col gap-2 text-center">
                    <NavAuthLink />
                  </div>
                </div>
              </details>
            </div>
          </nav>
          {children}
        </AlertProvider>
        <footer className="mt-auto w-full border-t border-white/10 py-4">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-6 px-4 text-sm text-slate-300 sm:px-6 lg:px-8">
            <Link
              href="/privacy"
              className="underline-offset-4 transition hover:text-white hover:underline"
            >
              Privacy
            </Link>
            <Link
              href="/tos"
              className="underline-offset-4 transition hover:text-white hover:underline"
            >
              TOS
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
