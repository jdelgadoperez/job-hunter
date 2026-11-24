import {
  Building2,
  House,
  ListChecks,
  type LucideIcon,
  Menu,
  Moon,
  Send,
  Settings as SettingsIcon,
  Sun,
  Target,
  X,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useVersion } from "./hooks";
import { useTheme } from "./theme";
import { Applications } from "./views/Applications";
import { Companies } from "./views/Companies";
import { Home } from "./views/Home";
import { Matches } from "./views/Matches";
import { Settings } from "./views/Settings";
import { Skills } from "./views/Skills";

const TABS = ["Home", "Matches", "Applications", "Skills", "Companies", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** Map the URL hash (e.g. `#companies`) to a tab, falling back to Home. Case-insensitive. */
function tabFromHash(): Tab {
  const raw = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  return TABS.find((t) => t.toLowerCase() === raw) ?? "Home";
}

function subscribeToHash(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

/** The active tab, read from the URL hash. Mirrors `useTheme`'s useSyncExternalStore shape so the
 *  two "sync external browser state into React" patterns are consistent. The hash is the single
 *  source of truth; selecting a tab writes it and the store re-reads. */
function useHashTab(): { tab: Tab; selectTab: (t: Tab) => void } {
  const tab = useSyncExternalStore(subscribeToHash, tabFromHash);
  const selectTab = (t: Tab) => {
    window.location.hash = t.toLowerCase();
  };
  return { tab, selectTab };
}

const TAB_ICONS: Record<Tab, LucideIcon> = {
  Home: House,
  Matches: Target,
  Applications: Send,
  Skills: ListChecks,
  Companies: Building2,
  Settings: SettingsIcon,
};

/** Tabs in the sidebar's main group; Settings sits apart at the bottom with the other utilities. */
const MAIN_TABS = TABS.filter((t) => t !== "Settings");

function NavItem({
  tab,
  active,
  onSelect,
}: {
  tab: Tab;
  active: boolean;
  onSelect: (t: Tab) => void;
}) {
  const Icon = TAB_ICONS[tab];
  return (
    <button
      type="button"
      onClick={() => onSelect(tab)}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${
        active ? "bg-active font-medium text-fg" : "text-muted hover:bg-subtle hover:text-fg"
      }`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="flex-none" />
      {tab}
    </button>
  );
}

function ThemeToggle({ theme, toggle }: { theme: string; toggle: () => void }) {
  const next = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="flex-none" />
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <img src="/favicon-32x32.png" alt="" width={24} height={24} className="h-6 w-6 rounded-md" />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">job-hunter</span>
    </span>
  );
}

export function App() {
  // The active tab lives in the URL hash so tabs are deep-linkable and the browser back/forward
  // buttons move between them — no router dependency.
  const { tab, selectTab } = useHashTab();
  const version = useVersion();
  const { theme, toggle } = useTheme();
  // Phone-width navigation: a full-screen sheet opened from the top bar. Rendered only while open,
  // so the sidebar's buttons are the only nav buttons in the DOM the rest of the time.
  const [menuOpen, setMenuOpen] = useState(false);
  const choose = (t: Tab) => {
    selectTab(t);
    setMenuOpen(false);
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
          <code className="font-mono">./update.ps1</code>), then reload this page.
        </div>
      ) : null}

      {/* Phone top bar: the product, the current view, and the menu button. */}
      <div className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-canvas px-4 lg:hidden">
        <Wordmark />
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
        </button>
      </div>
      {menuOpen ? (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 overflow-y-auto bg-canvas px-4 py-4 lg:hidden">
          <nav aria-label="Primary" className="space-y-0.5">
            {TABS.map((t) => (
              <NavItem key={t} tab={t} active={tab === t} onSelect={choose} />
            ))}
          </nav>
          <div className="mt-4 border-t border-border pt-4">
            <ThemeToggle theme={theme} toggle={toggle} />
          </div>
        </div>
      ) : null}

      <div className="lg:flex">
        {/* Sidebar on the page ground, divided from the canvas by one hairline. */}
        <aside className="sticky top-0 hidden h-screen w-60 flex-none flex-col border-r border-border px-3 py-5 lg:flex">
          <div className="px-2.5">
            <Wordmark />
          </div>
          {menuOpen ? null : (
            <nav aria-label="Primary" className="mt-7 flex flex-1 flex-col">
              <div className="space-y-0.5">
                {MAIN_TABS.map((t) => (
                  <NavItem key={t} tab={t} active={tab === t} onSelect={selectTab} />
                ))}
              </div>
              <div className="mt-auto space-y-0.5">
                <NavItem tab="Settings" active={tab === "Settings"} onSelect={selectTab} />
                <ThemeToggle theme={theme} toggle={toggle} />
                {version.data ? (
                  <p className="num px-2.5 pt-2 text-xs text-faint">v{version.data.version}</p>
                ) : null}
              </div>
            </nav>
          )}
        </aside>

        {/* Keep every tab mounted and toggle visibility, so local view state (Matches filters, draft
            form text) survives tab switches instead of being discarded on unmount. */}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-9">
          <div className="mx-auto max-w-[1120px]">
            <div hidden={tab !== "Home"}>
              <Home active={tab === "Home"} />
            </div>
            <div hidden={tab !== "Matches"}>
              <Matches />
            </div>
            <div hidden={tab !== "Applications"}>
              <Applications />
            </div>
            <div hidden={tab !== "Skills"}>
              <Skills />
            </div>
            <div hidden={tab !== "Companies"}>
              <Companies active={tab === "Companies"} />
            </div>
            <div hidden={tab !== "Settings"}>
              <Settings />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
