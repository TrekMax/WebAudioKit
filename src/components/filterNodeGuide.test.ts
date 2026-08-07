import { describe, expect, it } from 'vitest'

import { FILTER_DEFINITIONS, type FilterKind } from '../audio/filterGraph'
import {
  FILTER_GUIDE_CHART,
  FILTER_GUIDE_WAVEFORM_CHART,
  FILTER_NODE_GUIDES,
  buildFilterGuideSpectrum,
  buildFilterGuideSpectrumPath,
  buildFilterGuideWaveform,
  buildFilterGuideWaveformPath,
  filterGuideDbToY,
  filterGuideFrequencyToX,
  filterGuideWaveformValueToY,
} from './filterNodeGuide'

const FILTER_TYPES = Object.keys(FILTER_DEFINITIONS) as FilterKind[]

function pointNearestFrequency(type: FilterKind, frequencyHz: number) {
  return buildFilterGuideSpectrum(type).reduce((nearest, point) => (
    Math.abs(point.frequencyHz - frequencyHz) < Math.abs(nearest.frequencyHz - frequencyHz)
      ? point
      : nearest
  ))
}

describe('filter node guide examples', () => {
  it('provides readable copy and bounded spectrum points for every node type', () => {
    for (const type of FILTER_TYPES) {
      const copy = FILTER_NODE_GUIDES[type]
      const points = buildFilterGuideSpectrum(type)

      expect(copy.introduction.length).toBeGreaterThan(20)
      expect(copy.parameterSummary.length).toBeGreaterThan(10)
      expect(copy.visualSummary.length).toBeGreaterThan(10)
      expect(copy.visualKind).toMatch(/^(spectrum|waveform)$/)
      expect(points).toHaveLength(72)
      expect(points[0]?.frequencyHz).toBeCloseTo(FILTER_GUIDE_CHART.minimumFrequencyHz)
      expect(points.at(-1)?.frequencyHz).toBeCloseTo(FILTER_GUIDE_CHART.maximumFrequencyHz)
      expect(points.every((point) => (
        Number.isFinite(point.beforeDb)
        && Number.isFinite(point.afterDb)
        && point.beforeDb >= FILTER_GUIDE_CHART.minimumDb
        && point.afterDb >= FILTER_GUIDE_CHART.minimumDb
        && point.beforeDb <= FILTER_GUIDE_CHART.maximumDb
        && point.afterDb <= FILTER_GUIDE_CHART.maximumDb
      ))).toBe(true)
    }
  })

  it('illustrates the expected low-pass, high-pass and resampler direction', () => {
    const lowpassLow = pointNearestFrequency('lowpass', 100)
    const lowpassHigh = pointNearestFrequency('lowpass', 16_000)
    const highpassLow = pointNearestFrequency('highpass', 30)
    const highpassHigh = pointNearestFrequency('highpass', 8_000)
    const resamplerHigh = pointNearestFrequency('resampler', 16_000)

    expect(lowpassLow.afterDb - lowpassLow.beforeDb).toBeGreaterThan(-1)
    expect(lowpassHigh.afterDb - lowpassHigh.beforeDb).toBeLessThan(-20)
    expect(highpassLow.afterDb - highpassLow.beforeDb).toBeLessThan(-20)
    expect(highpassHigh.afterDb - highpassHigh.beforeDb).toBeGreaterThan(-1)
    expect(resamplerHigh.afterDb - resamplerHigh.beforeDb).toBeLessThan(-20)
  })

  it('creates finite SVG paths for spectrum examples', () => {
    const points = buildFilterGuideSpectrum('lowpass', 24)

    expect(buildFilterGuideSpectrumPath(points, 'beforeDb')).toMatch(/^M /)
    expect(buildFilterGuideSpectrumPath(points, 'afterDb')).not.toContain('NaN')
    expect(filterGuideFrequencyToX(20)).toBe(FILTER_GUIDE_CHART.left)
    expect(filterGuideDbToY(FILTER_GUIDE_CHART.maximumDb)).toBe(FILTER_GUIDE_CHART.top)
    expect(() => buildFilterGuideSpectrum('lowpass', 7)).toThrow(RangeError)
  })

  it('uses waveform examples for phase and sample-rate effects', () => {
    expect(FILTER_NODE_GUIDES.allpass.visualKind).toBe('waveform')
    expect(FILTER_NODE_GUIDES.resampler.visualKind).toBe('waveform')
    expect(FILTER_NODE_GUIDES.lowpass.visualKind).toBe('spectrum')

    const allpass = buildFilterGuideWaveform('allpass')
    const resampler = buildFilterGuideWaveform('resampler')
    expect(allpass.some((point) => Math.abs(point.after - point.before) > 0.1)).toBe(true)
    expect(resampler.some((point) => Math.abs(point.after - point.before) > 0.1)).toBe(true)
    expect(buildFilterGuideWaveformPath(allpass, 'before')).toMatch(/^M /)
    expect(buildFilterGuideWaveformPath(resampler, 'after', true)).not.toContain('NaN')
    expect(filterGuideWaveformValueToY(1)).toBe(FILTER_GUIDE_WAVEFORM_CHART.top)
    expect(() => buildFilterGuideWaveform('allpass', 12)).toThrow(RangeError)
  })
})
