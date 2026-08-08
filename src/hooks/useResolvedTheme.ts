import { useEffect, useState } from 'react'

import type { ResolvedTheme } from '../theme'

function readResolvedTheme(): ResolvedTheme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
    ? 'light'
    : 'dark'
}

export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState(readResolvedTheme)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(readResolvedTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}
