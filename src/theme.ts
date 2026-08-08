export const THEME_STORAGE_KEY = 'webaudio-kit-theme'
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type ThemePreference = typeof THEME_PREFERENCES[number]
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value)
}

export function readThemePreference(storage: ThemeStorage | null = browserStorage()): ThemePreference {
  if (!storage) return 'system'
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | null = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Theme persistence is optional; the active in-memory preference still applies.
  }
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === 'system'
    ? systemPrefersDark ? 'dark' : 'light'
    : preference
}

export function browserPrefersDark(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyThemePreference(
  preference: ThemePreference,
  systemPrefersDark = browserPrefersDark(),
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const resolved = resolveThemePreference(preference, systemPrefersDark)
  root.dataset.theme = resolved
  root.dataset.themePreference = preference
  root.style.colorScheme = resolved
  return resolved
}

export function initializeTheme(): ThemePreference {
  const preference = readThemePreference()
  applyThemePreference(preference)
  return preference
}
