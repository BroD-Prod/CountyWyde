export default function About() {
    return (
        <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
            <section className="mx-auto w-full max-w-2xl">
                <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">About</p>
                    <h1 className="mt-2 text-3xl font-semibold text-slate-900">CountyWyde</h1>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                        CountyWyde helps you search county records and manage uploads from one simple interface.
                    </p>
                </div>
            </section>
        </main>
    )
}