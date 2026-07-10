import { describe, expect, it } from 'vitest'

import type { StftPreviewResult } from '../audio/analysis'
import {
  findSpectrumReference,
  isRenderableSpectrum,
  sampleSpectrumDb,
  sampleSpectrumSeries,
  type SpectrumComparisonSeries,
} from './spectrumSeries'

function createResult(overrides: Partial<StftPreviewResult> = {}): StftPreviewResult {
  return {
    sampleRate: 8_000,
    fftSize: 8,
    hopSize: 2,
    frameCount: 2,
    totalFrameCount: 2,
    firstFrame: 0,
    binCount: 5,
    window: 'hann',
    channelMode: { kind: 'channel', index: 0 },
    range: { start: 0, end: 10 },
    minDb: -100,
    maxDb: 0,
    frameIndices: new Float64Array([0, 1]),
    timesSeconds: new Float64Array([0.1, 0.2]),
    frequenciesHz: new Float64Array([0, 1_000, 2_000, 3_000, 4_000]),
    valuesDbfs: new Float32Array([
      -100, -90, -80, -70, -60,
      -50, -40, -30, -20, -10,
    ]),
    ...overrides,
  }
}

describe('spectrum comparison series', () => {
  it('samples the nearest frame and bin at a shared hover frequency', () => {
    const result = createResult()

    expect(sampleSpectrumDb(result, 0.18, 2_100, -100)).toBe(-30)
    expect(sampleSpectrumDb(result, 0.11, 20_000, -100)).toBe(-60)
  })

  it('preserves series order and metadata while sampling each result independently', () => {
    const series: SpectrumComparisonSeries[] = [
      { channelIndex: 3, label: 'LFE', color: '#ffb35c', result: createResult() },
      {
        channelIndex: 0,
        label: 'FL',
        color: '#20dfb1',
        result: createResult({
          sampleRate: 16_000,
          fftSize: 16,
          valuesDbfs: new Float32Array([
            -95, -85, -75, -65, -55,
            -45, -35, -25, -15, -5,
          ]),
        }),
      },
    ]

    expect(sampleSpectrumSeries(series, 0.2, 2_000, -100)).toEqual([
      { channelIndex: 3, label: 'LFE', color: '#ffb35c', db: -30 },
      { channelIndex: 0, label: 'FL', color: '#20dfb1', db: -25 },
    ])
  })

  it('uses the first renderable series as the axis reference and skips empty data', () => {
    const empty = createResult({
      frameCount: 0,
      valuesDbfs: new Float32Array(),
      timesSeconds: new Float64Array(),
    })
    const valid = createResult()
    const series: SpectrumComparisonSeries[] = [
      { channelIndex: 0, label: 'FL', color: '#20dfb1', result: empty },
      { channelIndex: 1, label: 'FR', color: '#64a9ff', result: valid },
    ]

    expect(isRenderableSpectrum(empty)).toBe(false)
    expect(findSpectrumReference(series)).toBe(valid)
    expect(sampleSpectrumSeries(series, 0.2, 1_000, -100)).toEqual([
      { channelIndex: 1, label: 'FR', color: '#64a9ff', db: -40 },
    ])
  })
})
