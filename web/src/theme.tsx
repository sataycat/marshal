import { createContext, useContext, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "marshal-theme";

export type ThemeMode = "system" | "dracula" | "alucard";
export type ResolvedTheme = Exclude<ThemeMode, "system">;

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "dracula" || value === "alucard";
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dracula" : "alucard";
}

function getInitialMode(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : "dracula";
}

function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dracula");
  document.documentElement.style.colorScheme = theme === "dracula" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    mode === "system" ? getSystemTheme() : mode,
  );

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);

    const updateTheme = (): void => {
      const nextTheme = mode === "system" ? getSystemTheme() : mode;
      setResolvedTheme(nextTheme);
      applyTheme(nextTheme);
    };

    updateTheme();
    if (mode !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, [mode]);

  const setMode = (nextMode: ThemeMode): void => {
    const nextTheme = nextMode === "system" ? getSystemTheme() : nextMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    setModeState(nextMode);
    setResolvedTheme(nextTheme);
    applyTheme(nextTheme);
  };

  return <ThemeContext.Provider value={{ mode, resolvedTheme, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
