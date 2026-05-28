type LoadingProps = {
  label?: string;
  inline?: boolean;
};

export default function Loading({
  label = "Loading...",
  inline = false,
}: LoadingProps) {
  if (inline) {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          aria-hidden="true"
        />
        <span>{label}</span>
      </span>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-lg font-medium text-white">
        <span
          className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white"
          aria-hidden="true"
        />
        <span>{label}</span>
      </div>
    </div>
  );
}
