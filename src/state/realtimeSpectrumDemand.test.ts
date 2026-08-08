import { describe, expect, it } from 'vitest'

import { shouldRunRealtimeSpectrum } from './realtimeSpectrumDemand'

describe('realtime spectrum demand', () => {
  it('runs only for the visible analysis-workspace spectrum', () => {
    expect(shouldRunRealtimeSpectrum({
      appPage: 'analysis',
      analysisView: 'spectrum',
      filterView: 'waveform',
    })).toBe(true)
    expect(shouldRunRealtimeSpectrum({
      appPage: 'analysis',
      analysisView: 'spectrogram',
      filterView: 'spectrum',
    })).toBe(false)
    expect(shouldRunRealtimeSpectrum({
      appPage: 'analysis',
      analysisView: '3d',
      filterView: 'spectrum',
    })).toBe(false)
  })

  it('runs only for the visible A/B spectrum on the filter page', () => {
    expect(shouldRunRealtimeSpectrum({
      appPage: 'filters',
      analysisView: 'spectrogram',
      filterView: 'spectrum',
    })).toBe(true)
    expect(shouldRunRealtimeSpectrum({
      appPage: 'filters',
      analysisView: 'spectrum',
      filterView: 'waveform',
    })).toBe(false)
    expect(shouldRunRealtimeSpectrum({
      appPage: 'filters',
      analysisView: 'spectrum',
      filterView: 'spectrogram',
    })).toBe(false)
  })
})
