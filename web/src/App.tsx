import { useEffect, useState } from "react";
import { useVersion } from "./hooks";
import { useTheme } from "./theme";
import { Companies } from "./views/Companies";
import { Matches } from "./views/Matches";
import { Overview } from "./views/Overview";
import { Settings } from "./views/Settings";
import { Skills } from "./views/Skills";

const TABS = ["Overview", "Matches", "Skills", "Companies", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** Map the URL hash (e.g. `#companies`) to a tab, falling back to Overview. Case-insensitive. */
function tabFromHash(): Tab {
  const raw = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  return TABS.find((t) => t.toLowerCase() === raw) ?? "Overview";
}

export function App() {
  // The active tab lives in the URL hash so tabs are deep-linkable and the browser back/forward
  // buttons move between them. We sync React state ↔ hash rather than add a router dependency.
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const version = useVersion();
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Updating the hash fires `hashchange`, which sets the tab — keeping one source of truth.
  const selectTab = (t: Tab) => {
    window.location.hash = t.toLowerCase();
  };

  return (
    <div className="min-h-screen bg-canvas text-fg">
      {version.data?.updateAvailable ? (
        <div
          aria-live="polite"
          className="bg-primary px-4 py-2 text-center text-sm text-on-primary"
        >
          An update is available ({version.data.behind} new commit
          {version.data.behind === 1 ? "" : "s"}). Run{" "}
          <code className="font-mono">./update.sh</code> (or{" "}
          <code className="font-mono">./update.ps1</code>) and restart.
        </div>
      ) : null}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <h1 className="text-lg font-bold">
            job<span className="text-primary">-hunter</span>
          </h1>
          <div className="flex items-center gap-1">
            <nav aria-label="Primary" className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => selectTab(t)}
                  aria-current={tab === t ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    tab === t
                      ? "bg-primary text-on-primary"
                      : "text-muted hover:bg-subtle hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ))}
            </nav>
            <button
              type="button"
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="ml-1 rounded-md px-2 py-1.5 text-base text-muted transition hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
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
