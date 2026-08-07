import { describe, expect, it } from 'vitest'

import { calculateFloatingInspectorPosition } from './floatingInspector'

describe('calculateFloatingInspectorPosition', () => {
  it('prefers the anchor right side and keeps the panel inside vertical bounds', () => {
    expect(calculateFloatingInspectorPosition(
      { left: 200, right: 294, top: 500 },
      { width: 1_000, height: 600 },
      { width: 300, height: 200 },
    )).toEqual({ left: 306, top: 388 })
  })

  it('flips to the left and clamps narrow or top-edge layouts', () => {
    expect(calculateFloatingInspectorPosition(
      { left: 850, right: 944, top: 20 },
      { width: 1_000, height: 600 },
      { width: 300, height: 400 },
    )).toEqual({ left: 538, top: 66 })
    expect(calculateFloatingInspectorPosition(
      { left: 10, right: 104, top: 90 },
      { width: 250, height: 300 },
      { width: 300, height: 200 },
    )).toEqual({ left: 12, top: 88 })
  })
})
