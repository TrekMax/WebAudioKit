import { describe, expect, it } from 'vitest'

import {
  MIN_WAVEFORM_CHANNEL_HEIGHT,
  calculateWaveformCanvasHeight,
  normalizeVisibleChannels,
} from './waveformLayout'

describe('waveform channel layout', () => {
  it('keeps the requested source-channel order while removing invalid duplicates', () => {
    expect(normalizeVisibleChannels(
      [3, 1, 3, -1, 4, 1.5, Number.NaN, 0],
      4,
    )).toEqual([3, 1, 0])
  })

  it('returns no tracks when the source channel count is invalid or nothing is visible', () => {
    expect(normalizeVisibleChannels([], 8)).toEqual([])
    expect(normalizeVisibleChannels([0], 0)).toEqual([])
    expect(normalizeVisibleChannels([0], Number.NaN)).toEqual([])
  })

  it('uses the host height until the minimum per-track height requires scrolling', () => {
    expect(calculateWaveformCanvasHeight(200, 2)).toBe(200)
    expect(calculateWaveformCanvasHeight(200, 3)).toBe(
      24 + 3 * MIN_WAVEFORM_CHANNEL_HEIGHT,
    )
    expect(calculateWaveformCanvasHeight(100, 8)).toBe(
      24 + 8 * MIN_WAVEFORM_CHANNEL_HEIGHT,
    )
  })

  it('sanitizes invalid layout measurements', () => {
    expect(calculateWaveformCanvasHeight(Number.NaN, -1)).toBe(24)
    expect(calculateWaveformCanvasHeight(180.4, Number.POSITIVE_INFINITY)).toBe(180)
  })
})
