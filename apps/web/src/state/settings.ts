import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'sepia';
export type ReadingFont = 'sans' | 'serif' | 'dyslexic';

export interface Settings {
  theme: Theme;
  readingFont: ReadingFont;
  fontSize: number;
  /** Keep the active sentence in view automatically. */
  autoScroll: boolean;
  /** Paint a tint behind the whole active sentence as well as the word pill. */
  sentenceHighlight: boolean;
}

const KEY = 'pagecast.settings';

const DEFAULTS: Settings = {
  theme: prefersDark() ? 'dark' : 'light',
  readingFont: 'sans',
  fontSize: 19,
  autoScroll: true,
  sentenceHighlight: true,
};

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

/** Applied to <html> so a theme change is one attribute write. */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme);
  root.setAttribute('data-reading-font', settings.readingFont);
  root.style.setProperty('--reading-size', `${settings.fontSize}px`);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  useEffect(() => {
    applySettings(settings);
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Storage blocked: the setting still applies for this session.
    }
  }, [settings]);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  return { settings, update };
}
