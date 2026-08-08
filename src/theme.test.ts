import { describe, expect, it } from 'vitest'

import {
  THEME_STORAGE_KEY,
  isThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveThemePreference,
} from './theme'

function createStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem: (key: string) => key === THEME_STORAGE_KEY ? value : null,
    setItem: (key: string, nextValue: string) => {
      if (key === THEME_STORAGE_KEY) value = nextValue
    },
    value: () => value,
  }
}

describe('theme preference', () => {
  it('accepts only the supported preferences', () => {
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('sepia')).toBe(false)
  })

  it('falls back to system when storage is missing or invalid', () => {
    expect(readThemePreference(null)).toBe('system')
    expect(readThemePreference(createStorage('sepia'))).toBe('system')
  })

  it('persists and restores a supported preference', () => {
    const storage = createStorage()
    persistThemePreference('light', storage)
    expect(storage.value()).toBe('light')
    expect(readThemePreference(storage)).toBe('light')
  })

  it('resolves automatic mode from the system color scheme', () => {
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
    expect(resolveThemePreference('light', true)).toBe('light')
    expect(resolveThemePreference('dark', false)).toBe('dark')
  })
})
