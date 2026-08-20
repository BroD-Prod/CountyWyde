export default function TermsOfServicePage() {
  return (
    <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-3xl">
        <div className="border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
            Legal
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-50">
            Terms of Service
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-300">
            Last updated: May 28, 2026
          </p>

          <div className="mt-6 space-y-5 text-sm leading-7 text-slate-300">
            <p>
              By using CountyWyde, you agree to use the platform only for lawful
              and authorized county-related search and document workflows.
            </p>
            <p>
              You are responsible for the accuracy of account information and
              any files you upload. Do not upload content you do not have
              permission to store or process.
            </p>
            <p>
              Access may be suspended or terminated for misuse, abuse, or
              attempts to compromise system security or data integrity.
            </p>
            <p>
              CountyWyde is provided on an as-is basis and may change over time.
              We may update these terms as needed, and continued use after
              updates means you accept the revised terms.
            </p>
            <p>
              If you do not agree with these terms, discontinue use of the
              application.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
