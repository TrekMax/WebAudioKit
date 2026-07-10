import { describe, expect, it } from 'vitest'

import { fftRadix2, fftRadix2InPlace, isValidFftSize } from './fft'

describe('radix-2 FFT', () => {
  it('transforms an impulse into a flat complex spectrum', () => {
    const input = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0])
    const { real, imaginary } = fftRadix2(input)

    expect(input).toEqual(Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0]))
    for (let index = 0; index < input.length; index += 1) {
      expect(real[index]).toBeCloseTo(1, 12)
      expect(imaginary[index]).toBeCloseTo(0, 12)
    }
  })

  it('places a bin-centred sine at the matching positive and negative bins', () => {
    const size = 32
    const targetBin = 5
    const input = Float64Array.from(
      { length: size },
      (_, index) => Math.sin((2 * Math.PI * targetBin * index) / size),
    )
    const { real, imaginary } = fftRadix2(input)

    expect(real[targetBin]).toBeCloseTo(0, 10)
    expect(imaginary[targetBin]).toBeCloseTo(-size / 2, 10)
    expect(real[size - targetBin]).toBeCloseTo(0, 10)
    expect(imaginary[size - targetBin]).toBeCloseTo(size / 2, 10)
  })

  it('supports complex input in place', () => {
    const real = Float64Array.from([1, 0, 0, 0])
    const imaginary = Float64Array.from([0, 1, 0, 0])

    fftRadix2InPlace(real, imaginary)

    const expectedReal = [1, 2, 1, 0]
    const expectedImaginary = [1, 0, -1, 0]
    for (let index = 0; index < real.length; index += 1) {
      expect(real[index]).toBeCloseTo(expectedReal[index] ?? 0, 12)
      expect(imaginary[index]).toBeCloseTo(
        expectedImaginary[index] ?? 0,
        12,
      )
    }
  })

  it('rejects non-radix-2 sizes and mismatched buffers', () => {
    expect(isValidFftSize(0)).toBe(false)
    expect(isValidFftSize(1)).toBe(false)
    expect(isValidFftSize(12)).toBe(false)
    expect(isValidFftSize(1024)).toBe(true)

    expect(() => fftRadix2(new Float64Array(12))).toThrow(RangeError)
    expect(() =>
      fftRadix2InPlace(new Float64Array(8), new Float64Array(4)),
    ).toThrow(RangeError)
  })

  it('rejects non-finite FFT input instead of propagating NaN', () => {
    expect(() => fftRadix2([0, 1, Number.NaN, 0])).toThrow(TypeError)
    expect(() => fftRadix2([0, 1, Number.POSITIVE_INFINITY, 0])).toThrow(
      TypeError,
    )
  })
})
