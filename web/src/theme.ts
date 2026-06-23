import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The current theme: a saved choice if present, otherwise the OS preference. */
export function currentTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return systemPrefersDark() ? "dark" : "light";
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Persist + apply a theme and notify subscribers. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  apply(theme);
  for (const cb of listeners) cb();
}

/** Reactive theme state with a toggle. The pre-paint script in index.html sets the initial class. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme]);
  return { theme, toggle };
}
