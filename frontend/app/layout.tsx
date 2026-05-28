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
        <AlertProvider> <nav className="sticky w-full p-4 bg-slate-950/75 text-white flex justify-between items-center top-0 z-40 border-b border-white/10 backdrop-blur-xl">
         
            <div className="text-2xl font-bold">CountyWyde</div>
            <div className="space-x-4">
              <Link href="/" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">
                Home
              </Link>
              <Link href="/about" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">
                About
              </Link>
              <Link href="/contact" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">
                Contact
              </Link>
              <NavAuthLink />
              </div>
          </nav>
          {children}
        </AlertProvider>
      </body>
    </html>
  );
}
