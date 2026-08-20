import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import NavAuthLink from "./components/NavAuthLink";
import AlertProvider from "./components/AlertProvider";
import VantaNetBackground from "./components/VantaNetBackground";

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
    <html lang="en" className="h-full antialiased">
      <body className="relative min-h-full overflow-x-hidden bg-[#020817] text-slate-100">
        <VantaNetBackground />

        <div className="relative z-10 flex min-h-full flex-col">
          <AlertProvider>
            <nav className="sticky top-0 z-40 w-full border-b border-sky-300/20 bg-slate-950/60 px-4 py-3 text-white backdrop-blur-xl">
              <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
                <Link href="/" className="text-2xl font-bold tracking-tight text-slate-50 transition hover:text-sky-200">
                  CountyWyde
                </Link>

                <div className="hidden items-center gap-2 sm:flex">
                  <Link
                    href="/"
                    className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
                  >
                    Home
                  </Link>
                  <Link
                    href="/about"
                    className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
                  >
                    About
                  </Link>
                  <Link
                    href="/contact"
                    className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
                  >
                    Contact
                  </Link>
                  <NavAuthLink />
                </div>

                <details className="relative sm:hidden">
                  <summary className="cursor-pointer list-none border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100">
                    Menu
                  </summary>
                  <div className="absolute right-0 mt-2 flex w-64 flex-col gap-2 border border-white/10 bg-slate-950/80 p-3 shadow-[0_0_25px_rgba(14,165,233,0.12)] backdrop-blur-xl">
                    <Link
                      href="/"
                      className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-center text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
                    >
                      Home
                    </Link>
                    <Link
                      href="/about"
                      className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-center text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
                    >
                      About
                    </Link>
                    <Link
                      href="/contact"
                      className="border border-sky-300/15 bg-slate-900/60 px-4 py-2 text-center text-sm text-slate-100 transition hover:border-sky-300/40 hover:bg-sky-500/10 hover:text-sky-100"
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
          <footer className="mt-auto w-full border-t border-sky-300/20 bg-slate-950/60 py-4 backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-6 px-4 text-sm text-slate-300 sm:px-6 lg:px-8">
              <Link
                href="/privacy"
                className="transition hover:text-sky-100 hover:underline hover:decoration-sky-300/50 underline-offset-4"
              >
                Privacy
              </Link>
              <Link
                href="/tos"
                className="transition hover:text-sky-100 hover:underline hover:decoration-sky-300/50 underline-offset-4"
              >
                TOS
              </Link>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
