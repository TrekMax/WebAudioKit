import { describe, expect, it, vi } from 'vitest'

import {
  getCachedTrackFrequencyResponse,
  getCachedTrackOverviewRange,
  getCachedTrackResamplerOverviewRange,
  getCachedTrackSpectrogramPixels,
} from './trackPreviewCache'

describe('track preview cache', () => {
  it('reuses source and sampler overviews for the same visible range', () => {
    const sourceIdentity = {}
    const channels = [Float32Array.from({ length: 64 }, (_, index) => Math.sin(index))]
    const range = { start: 0, end: 32 }
    const source = getCachedTrackOverviewRange(sourceIdentity, channels, 16, range, 4)
    const repeatedSource = getCachedTrackOverviewRange(sourceIdentity, channels, 16, range, 4)
    expect(repeatedSource).toBe(source)
    expect(getCachedTrackOverviewRange(
      sourceIdentity,
      channels,
      16,
      { start: 16, end: 48 },
      4,
    )).not.toBe(source)

    const config = {
      sourceSampleRateHz: 48_000,
      contextSampleRateHz: 48_000,
      targetSampleRateHz: 8_000,
      algorithm: 'hold' as const,
    }
    const filtered = getCachedTrackResamplerOverviewRange(
      sourceIdentity,
      channels,
      16,
      range,
      config,
      4,
    )
    expect(getCachedTrackResamplerOverviewRange(
      sourceIdentity,
      channels,
      16,
      range,
      config,
      4,
    )).toBe(filtered)
    expect(getCachedTrackResamplerOverviewRange(
      sourceIdentity,
      channels,
      16,
      range,
      { ...config, algorithm: 'cubic' },
      4,
    )).not.toBe(filtered)
    expect(filtered).not.toBe(source)
  })

  it('shares source spectrogram pixels and invalidates filtered revisions', () => {
    const result = {
      frameCount: 2,
      binCount: 2,
      minDb: -100,
      maxDb: 0,
      valuesDbfs: Float32Array.from([-100, -50, -25, 0]),
    }
    const source = getCachedTrackSpectrogramPixels(result, null, null)
    expect(getCachedTrackSpectrogramPixels(result, null, null)).toBe(source)

    const response = Float32Array.from([0, -12])
    const filtered = getCachedTrackSpectrogramPixels(result, response, 'filters:v1')
    expect(getCachedTrackSpectrogramPixels(result, response, 'filters:v1')).toBe(filtered)
    expect(getCachedTrackSpectrogramPixels(result, response, 'filters:v2')).not.toBe(filtered)
    expect(() => getCachedTrackSpectrogramPixels(result, response, null)).toThrow('revision')
  })

  it('reuses compiled responses and does not cache unavailable results', () => {
    const analysisIdentity = {}
    const create = vi.fn(() => Float32Array.from([0, -3]))
    const first = getCachedTrackFrequencyResponse(analysisIdentity, 'filters:v1', create)
    const repeated = getCachedTrackFrequencyResponse(analysisIdentity, 'filters:v1', create)
    expect(repeated).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)

    const unavailable = vi.fn(() => null)
    expect(getCachedTrackFrequencyResponse(
      analysisIdentity,
      'filters:unavailable',
      unavailable,
    )).toBeNull()
    expect(getCachedTrackFrequencyResponse(
      analysisIdentity,
      'filters:unavailable',
      unavailable,
    )).toBeNull()
    expect(unavailable).toHaveBeenCalledTimes(2)
  })

  it('evicts old waveform zoom levels after the per-source limit', () => {
    const sourceIdentity = {}
    const channels = [Float32Array.from({ length: 32 }, (_, index) => index / 32)]
    const first = getCachedTrackOverviewRange(
      sourceIdentity,
      channels,
      1,
      { start: 0, end: 1 },
      1,
    )
    for (let index = 1; index <= 12; index += 1) {
      getCachedTrackOverviewRange(
        sourceIdentity,
        channels,
        1,
        { start: index, end: index + 1 },
        1,
      )
    }
    expect(getCachedTrackOverviewRange(
      sourceIdentity,
      channels,
      1,
      { start: 0, end: 1 },
      1,
    )).not.toBe(first)
  })
})
