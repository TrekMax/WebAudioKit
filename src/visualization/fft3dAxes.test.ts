import { describe, expect, it } from 'vitest'
import type { StftPreviewResult } from '../audio/analysis'
import { buildFft3DAxisTicks } from './fft3dAxes'

function result(
  timesSeconds: readonly number[],
  sampleRate = 48_000,
  frequenciesHz: readonly number[] = [0, 20, 1_000, 24_000],
): StftPreviewResult {
  const frameCount = timesSeconds.length
  const binCount = frequenciesHz.length
  return {
    sampleRate,
    fftSize: 2048,
    hopSize: 512,
    frameCount,
    totalFrameCount: frameCount,
    firstFrame: 0,
    binCount,
    window: 'hann',
    channelMode: { kind: 'mix' },
    range: { start: 0, end: Math.max(1, Math.round((timesSeconds.at(-1) ?? 0) * sampleRate)) },
    minDb: -100,
    maxDb: 0,
    frameIndices: Float64Array.from(timesSeconds.map((_, index) => index)),
    timesSeconds: Float64Array.from(timesSeconds),
    frequenciesHz: Float64Array.from(frequenciesHz),
    valuesDbfs: new Float32Array(frameCount * binCount),
  }
}

function expectNormalizedUnique(ticks: readonly { unit: number; value: number }[]): void {
  expect(ticks.length).toBeGreaterThanOrEqual(1)
  expect(ticks.length).toBeLessThanOrEqual(6)
  expect(new Set(ticks.map((tick) => tick.value)).size).toBe(ticks.length)
  for (const tick of ticks) {
    expect(tick.unit).toBeGreaterThanOrEqual(0)
    expect(tick.unit).toBeLessThanOrEqual(1)
  }
}

describe('buildFft3DAxisTicks', () => {
  it('uses the first and last STFT times without collapsing short ranges', () => {
    const axes = buildFft3DAxisTicks(
      result([0.001, 0.003, 0.005, 0.007, 0.009]),
      -100,
      0,
      'linear',
    )

    expect(axes.time).toHaveLength(5)
    expect(axes.time[0]).toEqual({ unit: 0, value: 0.001, label: '0.001 s' })
    expect(axes.time.at(-1)).toEqual({ unit: 1, value: 0.009, label: '0.009 s' })
    expect(new Set(axes.time.map((tick) => tick.label)).size).toBe(5)
    expectNormalizedUnique(axes.time)
  })

  it('creates linear frequency ticks including zero and Nyquist', () => {
    const axes = buildFft3DAxisTicks(result([0, 1]), -96, 0, 'linear')

    expect(axes.frequency).toHaveLength(5)
    expect(axes.frequency[0]).toEqual({ unit: 0, value: 0, label: '0 Hz' })
    expect(axes.frequency.at(-1)).toEqual({ unit: 1, value: 24_000, label: '24 kHz' })
    expectNormalizedUnique(axes.frequency)
  })

  it('maps logarithmic frequency ticks from the available 20 Hz floor', () => {
    const axes = buildFft3DAxisTicks(
      result([0, 1], 48_000, [0, 10, 20, 100, 1_000, 24_000]),
      -100,
      0,
      'log',
    )

    expect(axes.frequency).toHaveLength(5)
    expect(axes.frequency[0]).toEqual({ unit: 0, value: 20, label: '20 Hz' })
    expect(axes.frequency.at(-1)).toEqual({ unit: 1, value: 24_000, label: '24 kHz' })
    expect(axes.frequency.map((tick) => tick.unit)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expectNormalizedUnique(axes.frequency)
  })

  it('uses the first available FFT bin when it is above 20 Hz', () => {
    const axes = buildFft3DAxisTicks(
      result([0, 1], 44_100, [0, 21.533, 43.066, 22_050]),
      -80,
      -2,
      'log',
    )

    expect(axes.frequency[0]?.value).toBeCloseTo(21.533)
    expect(axes.frequency.at(-1)?.value).toBe(22_050)
    expect(axes.frequency.at(-1)?.label).toBe('22.05 kHz')
  })

  it('includes amplitude boundaries and handles a single time/frequency point', () => {
    const axes = buildFft3DAxisTicks(
      result([0.125], 32, [0, 16]),
      -120,
      -6,
      'log',
    )

    expect(axes.time).toEqual([{ unit: 0, value: 0.125, label: '0.125 s' }])
    expect(axes.frequency).toEqual([{ unit: 0, value: 16, label: '16 Hz' }])
    expect(axes.amplitude[0]).toEqual({ unit: 0, value: -120, label: '-120 dBFS' })
    expect(axes.amplitude.at(-1)).toEqual({ unit: 1, value: -6, label: '-6 dBFS' })
    expectNormalizedUnique(axes.amplitude)
  })

  it('rejects invalid amplitude ranges', () => {
    const preview = result([0, 1])
    expect(() => buildFft3DAxisTicks(preview, 0, 0, 'linear')).toThrow(RangeError)
    expect(() => buildFft3DAxisTicks(preview, Number.NaN, 0, 'linear')).toThrow(RangeError)
  })
})
