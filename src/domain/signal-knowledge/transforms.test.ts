import { describe, expect, it } from 'vitest'

import {
  complexFromPolar,
  complexMagnitude,
  complexPhase,
  multiplyComplex,
} from './complex'
import {
  computeDft,
  computeDftBin,
  computeDftBinContributions,
  computeTeachingStft,
  createSingleSidedMagnitudeSpectrum,
  generateTeachingSignal,
} from './transforms'

describe('signal knowledge complex math', () => {
  it('converts polar values and multiplies rotations', () => {
    const first = complexFromPolar(2, Math.PI / 3)
    const second = complexFromPolar(0.5, Math.PI / 6)
    const product = multiplyComplex(first, second)

    expect(complexMagnitude(first)).toBeCloseTo(2, 12)
    expect(complexMagnitude(product)).toBeCloseTo(1, 12)
    expect(complexPhase(product)).toBeCloseTo(Math.PI / 2, 12)
  })
})

describe('signal knowledge DFT', () => {
  it('places a DC signal in bin zero', () => {
    const spectrum = computeDft([1, 1, 1, 1])

    expect(spectrum[0]?.real).toBeCloseTo(4, 12)
    expect(spectrum[0]?.imaginary).toBeCloseTo(0, 12)
    for (const bin of spectrum.slice(1)) {
      expect(complexMagnitude(bin)).toBeCloseTo(0, 12)
    }
  })

  it('gives an impulse equal magnitude in every bin', () => {
    const spectrum = computeDft([1, 0, 0, 0, 0, 0, 0, 0])

    for (const bin of spectrum) {
      expect(bin.real).toBeCloseTo(1, 12)
      expect(bin.imaginary).toBeCloseTo(0, 12)
    }
  })

  it('recovers a bin-aligned cosine amplitude and phase', () => {
    const phaseRadians = Math.PI / 3
    const samples = generateTeachingSignal({
      kind: 'sine',
      sampleCount: 32,
      cycles: 5,
      phaseRadians,
    })
    const spectrum = createSingleSidedMagnitudeSpectrum(samples)

    expect(spectrum[5]?.magnitude).toBeCloseTo(1, 12)
    expect(spectrum[5]?.phaseRadians).toBeCloseTo(phaseRadians, 12)
    expect(spectrum[4]?.magnitude).toBeCloseTo(0, 12)
    expect(spectrum[6]?.magnitude).toBeCloseTo(0, 12)
  })

  it('makes contribution partial sums agree with the final DFT bin', () => {
    const samples = generateTeachingSignal({
      kind: 'sine',
      sampleCount: 16,
      cycles: 3,
    })
    const contributions = computeDftBinContributions(samples, 3)
    const final = contributions.at(-1)?.partialSum
    const bin = computeDftBin(samples, 3)

    expect(final?.real).toBeCloseTo(bin.real, 12)
    expect(final?.imaginary).toBeCloseTo(bin.imaginary, 12)
  })

  it('maps non-finite teaching samples to silence', () => {
    const spectrum = computeDft([Number.NaN, Number.POSITIVE_INFINITY, -Infinity, 0])

    for (const bin of spectrum) {
      expect(bin.real).toBeCloseTo(0, 12)
      expect(bin.imaginary).toBeCloseTo(0, 12)
    }
  })

  it('returns no bins for an empty frame and rejects invalid bins', () => {
    expect(computeDft([])).toEqual([])
    expect(createSingleSidedMagnitudeSpectrum([])).toEqual([])
    expect(() => computeDftBin([1, 0], 2)).toThrow(RangeError)
  })
})

describe('signal knowledge STFT', () => {
  it('creates a finite bounded time-frequency model', () => {
    const samples = generateTeachingSignal({
      kind: 'chirp',
      sampleCount: 128,
      cycles: 4,
    })
    const model = computeTeachingStft(samples, 32, 8, 'hann')

    expect(model.frameCount).toBe(13)
    expect(model.binCount).toBe(17)
    expect(model.magnitudes).toHaveLength(model.frameCount * model.binCount)
    expect(model.maxMagnitude).toBeGreaterThan(0)
    expect(Array.from(model.magnitudes).every(Number.isFinite)).toBe(true)

    const dominantBinAt = (frame: number) => {
      let dominantBin = 0
      let dominantMagnitude = -Infinity
      for (let bin = 0; bin < model.binCount; bin += 1) {
        const magnitude = model.magnitudes[frame * model.binCount + bin] ?? 0
        if (magnitude > dominantMagnitude) {
          dominantBin = bin
          dominantMagnitude = magnitude
        }
      }
      return dominantBin
    }
    expect(dominantBinAt(model.frameCount - 1)).toBeGreaterThan(
      dominantBinAt(0),
    )
  })

  it('keeps silence at zero and validates bounded parameters', () => {
    const silence = generateTeachingSignal({ kind: 'silence', sampleCount: 32 })
    const model = computeTeachingStft(silence, 16, 4, 'rectangular')

    expect(model.maxMagnitude).toBe(0)
    expect(Array.from(model.magnitudes).every((value) => value === 0)).toBe(true)
    expect(() => computeTeachingStft(silence, 16, 17, 'hann')).toThrow(RangeError)
    expect(() => generateTeachingSignal({ kind: 'sine', sampleCount: 129 })).toThrow(RangeError)
  })
})
