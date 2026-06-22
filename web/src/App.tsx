import { useState } from "react";
import { Companies } from "./views/Companies";
import { Matches } from "./views/Matches";
import { Overview } from "./views/Overview";
import { Settings } from "./views/Settings";
import { Skills } from "./views/Skills";

const TABS = ["Overview", "Matches", "Skills", "Companies", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold">
            job<span className="text-indigo-600">-hunter</span>
          </h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  tab === t ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {tab === "Overview" ? <Overview /> : null}
        {tab === "Matches" ? <Matches /> : null}
        {tab === "Skills" ? <Skills /> : null}
        {tab === "Companies" ? <Companies /> : null}
        {tab === "Settings" ? <Settings /> : null}
      </main>
    </div>
  );
}
