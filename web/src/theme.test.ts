import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTheme, setTheme, useTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("currentTheme", () => {
  it("returns the saved choice when one is stored", () => {
    localStorage.setItem("theme", "dark");
    expect(currentTheme()).toBe("dark");
  });

  it("falls back to the OS preference when nothing is saved", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    expect(currentTheme()).toBe("dark");
  });

  it("falls back to light when no preference and no OS dark mode", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    expect(currentTheme()).toBe("light");
  });
});

describe("useTheme", () => {
  it("toggles and persists the theme", () => {
    localStorage.setItem("theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("notifies every subscriber when the theme changes (cross-component sync)", () => {
    localStorage.setItem("theme", "light");
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());

    act(() => setTheme("dark"));

    expect(first.result.current.theme).toBe("dark");
    expect(second.result.current.theme).toBe("dark");
  });
});
