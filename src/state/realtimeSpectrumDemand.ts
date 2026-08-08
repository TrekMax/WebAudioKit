export type RealtimeSpectrumAppPage = 'analysis' | 'filters'
export type RealtimeSpectrumAnalysisView = 'spectrum' | 'spectrogram' | '3d'
export type RealtimeSpectrumFilterView = 'waveform' | 'spectrum' | 'spectrogram'

interface RealtimeSpectrumViewState {
  readonly appPage: RealtimeSpectrumAppPage
  readonly analysisView: RealtimeSpectrumAnalysisView
  readonly filterView: RealtimeSpectrumFilterView
}

/**
 * Realtime FFT work is demand-driven. Offline spectrogram/3D views reuse their
 * stored STFT result and waveform previews read bounded source PCM directly.
 */
export function shouldRunRealtimeSpectrum({
  appPage,
  analysisView,
  filterView,
}: RealtimeSpectrumViewState): boolean {
  return appPage === 'analysis'
    ? analysisView === 'spectrum'
    : filterView === 'spectrum'
}
