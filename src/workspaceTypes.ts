export type SupportedFftSize = 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768
export type WindowName = 'hann' | 'hamming' | 'blackman'
export type OverlapRatio = 0 | 0.5 | 0.75 | 0.875
export type AnalysisChannel = 'mix' | number

export interface WorkspaceAnalysisConfig {
  fftSize: SupportedFftSize
  window: WindowName
  overlap: OverlapRatio
  channel: AnalysisChannel
  frequencyScale: 'linear' | 'log'
  minDb: number
  maxDb: number
}

export interface SampleSelection {
  start: number
  end: number
}

export const DEFAULT_ANALYSIS_CONFIG: WorkspaceAnalysisConfig = {
  fftSize: 2048,
  window: 'hann',
  overlap: 0.75,
  channel: 'mix',
  frequencyScale: 'log',
  minDb: -100,
  maxDb: 0,
}
