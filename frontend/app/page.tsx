'use client';
import { useEffect, useState } from 'react';
import { useAlert } from './components/AlertProvider';

export default function Home() {
  const [search, setSearch] = useState('');
  const [result, setResult] = useState('');
  const [county, setCounty] = useState('');
  const [state, setState] = useState('');
  const [counties, setCounties] = useState<string[]>([]);
  const [states, setStates] = useState<{ name: string; abbreviation: string }[]>([]);
  const { showAlert } = useAlert();

  useEffect(() => {
    if (!state) {
      setCounties([]);
      setCounty('');
      return;
    }

    fetch(`http://localhost:1337/counties?state=${encodeURIComponent(state)}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.counties)) {
          setCounties(data.counties);
        }
      })
      .catch(() => {
        setCounties([]);
      });
  }, [state]);

  useEffect(() => {
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
  }, []);

  const handleSearch = async () => {
    if (!search.trim()) {
      showAlert('Please enter a search query', 'error');
      return;
    }

    if (!county) {
      showAlert('Please select a county', 'error');
      return;
    }

    if (!state) {
      showAlert('Please select a state', 'error');
      return;
    }

    const response = await fetch('http://localhost:1337/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: search, county, state }),
    });

    const result = await response.json();
    if (!response.ok) {
      showAlert(result.error || 'Search failed', 'error');
      return;
    }

    const sourceList = Array.isArray(result.sources)
      ? result.sources.map((s: { source: string }) => s.source).join(', ')
      : 'none';

    setResult(`Result:\n\n${result.result}\n\nSources: ${sourceList}`);
  };

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-2xl">
        <div className="overflow-hidden rounded-4xl border border-white/10 bg-white/92 p-6 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-linear-to-r from-slate-700 via-slate-500 to-slate-700" />
          <div className="mb-6">
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Search CountyWyde</h2>
          </div>

          <div className="space-y-4">
            <select
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setCounty('');
              }}
            >
              <option value="">Select State</option>
              {states.map((s) => (
                <option key={s.abbreviation} value={s.abbreviation}>
                  {s.name}
                </option>
              ))}
            </select>

            <select
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              disabled={!state}
            >
              <option value="">Select County</option>
              {counties.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>

            <input
              className="block w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-black shadow-sm outline-none transition placeholder-slate-400 hover:border-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-200"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch();
                }
              }}
            />

            <button
              className="w-full rounded-2xl bg-linear-to-r from-slate-700 via-slate-600 to-slate-800 px-4 py-3 font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:from-slate-600 hover:to-slate-700"
              onClick={handleSearch}
            >
              Search
            </button>
          </div>

          {result && (
            <pre className="mt-6 whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left text-sm leading-6 text-slate-800 shadow-sm">
              {result}
            </pre>
          )}
        </div>
      </section>
    </main>
  );
}
