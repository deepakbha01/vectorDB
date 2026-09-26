import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Light / dark theme. The choice is kept per browser (localStorage) and set as
 * <html data-theme="...">; styles/global.css holds both token sets. index.html
 * applies the stored choice before React loads, so there is no flash.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'vp-theme';
const DEFAULT_THEME: Theme = 'dark';

function stored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: DEFAULT_THEME, setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(stored);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Storage blocked (private mode, policy): the choice lasts for this page only.
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Two-option switch for the top bar. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="theme-toggle">
      {(['light', 'dark'] as const).map((t) => (
        <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'active' : undefined} onClick={() => setTheme(t)} title={`${t === 'light' ? 'Light' : 'Dark'} theme`}>
          {t === 'light' ? '☀ Light' : '☾ Dark'}
        </button>
      ))}
    </div>
  );
}
