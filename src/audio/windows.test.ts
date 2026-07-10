import { describe, expect, it } from 'vitest'

import {
  applyWindow,
  calculateCoherentGain,
  createBlackmanWindow,
  createHammingWindow,
  createHannWindow,
  createWindow,
} from './windows'

describe('periodic analysis windows', () => {
  it('generates Hann coefficients with denominator N', () => {
    const window = createHannWindow(8)

    expect(window[0]).toBeCloseTo(0, 15)
    expect(window[1]).toBeCloseTo(0.1464466094, 9)
    expect(window[4]).toBeCloseTo(1, 15)
    expect(window[7]).toBeCloseTo(0.1464466094, 9)
    expect(calculateCoherentGain(window)).toBeCloseTo(0.5, 14)
  })

  it('generates Hamming coefficients and coherent gain', () => {
    const window = createHammingWindow(32)

    expect(window[0]).toBeCloseTo(0.08, 14)
    expect(window[16]).toBeCloseTo(1, 14)
    expect(calculateCoherentGain(window)).toBeCloseTo(0.54, 14)
  })

  it('generates Blackman coefficients and coherent gain', () => {
    const window = createBlackmanWindow(32)

    expect(window[0]).toBeCloseTo(0, 14)
    expect(window[16]).toBeCloseTo(1, 14)
    expect(calculateCoherentGain(window)).toBeCloseTo(0.42, 14)
  })

  it('dispatches named windows and applies them without mutating input', () => {
    const samples = Float32Array.from([1, 1, 1, 1])
    const window = createWindow('hann', 4)
    const output = applyWindow(samples, window)

    const expected = [0, 0.5, 1, 0.5]
    for (let index = 0; index < output.length; index += 1) {
      expect(output[index]).toBeCloseTo(expected[index] ?? 0, 14)
    }
    expect(Array.from(samples)).toEqual([1, 1, 1, 1])
  })

  it('rejects invalid window sizes and mismatched input', () => {
    expect(() => createWindow('hann', 0)).toThrow(RangeError)
    expect(() => createWindow('hann', 1)).toThrow(RangeError)
    expect(() => createWindow('hann', 4.5)).toThrow(RangeError)
    expect(() => applyWindow([1, 2], [1])).toThrow(RangeError)
  })
})
