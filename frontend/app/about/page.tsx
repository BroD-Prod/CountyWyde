export default function About() {
  return (
    <main className="min-h-[calc(100vh-5rem)] bg-transparent px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="border border-sky-300/20 bg-slate-900/40 p-8 shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_0_30px_rgba(14,165,233,0.10)] backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">
            About
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-50">
            CountyWyde
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            CountyWyde helps you search county records and manage uploads from
            one simple interface.
          </p>
        </div>
      </section>
    </main>
  );
}
