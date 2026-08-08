import { useEffect, useLayoutEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

import {
  applyThemePreference,
  browserPrefersDark,
  persistThemePreference,
  readThemePreference,
  type ThemePreference,
} from '../theme'

const THEME_OPTIONS: ReadonlyArray<{
  readonly preference: ThemePreference
  readonly label: string
  readonly icon: typeof Sun
}> = [
  { preference: 'light', label: '使用亮色主题', icon: Sun },
  { preference: 'dark', label: '使用暗色主题', icon: Moon },
  { preference: 'system', label: '跟随系统主题', icon: Monitor },
]

export function ThemeSwitcher() {
  const [preference, setPreference] = useState(readThemePreference)
  const [systemPrefersDark, setSystemPrefersDark] = useState(browserPrefersDark)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useLayoutEffect(() => {
    persistThemePreference(preference)
    applyThemePreference(preference, systemPrefersDark)
  }, [preference, systemPrefersDark])

  return (
    <div className="theme-switcher" role="group" aria-label="界面主题">
      {THEME_OPTIONS.map(({ preference: option, label, icon: Icon }) => (
        <button
          key={option}
          type="button"
          className={preference === option ? 'active' : ''}
          aria-label={label}
          aria-pressed={preference === option}
          title={label}
          onClick={() => setPreference(option)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  )
}
