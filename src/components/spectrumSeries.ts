import type { StftPreviewResult } from '../audio/analysis'
import { nearestFrameIndex } from '../visualization/plotUtils'

export interface SpectrumComparisonSeries {
  readonly channelIndex: number
  readonly label: string
  readonly color: string
  readonly result: StftPreviewResult
}

export interface SpectrumSeriesSample {
  readonly channelIndex: number
  readonly label: string
  readonly color: string
  readonly db: number
}

export function isRenderableSpectrum(result: StftPreviewResult | null): result is StftPreviewResult {
  return result !== null && result.frameCount > 0 && result.binCount > 0
}

export function findSpectrumReference(
  series: readonly SpectrumComparisonSeries[],
): StftPreviewResult | null {
  return series.find(({ result }) => isRenderableSpectrum(result))?.result ?? null
}

export function sampleSpectrumDb(
  result: StftPreviewResult,
  timeSeconds: number,
  frequencyHz: number,
  fallbackDb: number,
): number {
  if (!isRenderableSpectrum(result)) return fallbackDb

  const frameIndex = nearestFrameIndex(result, timeSeconds)
  const binIndex = Math.max(
    0,
    Math.min(
      result.binCount - 1,
      Math.round(frequencyHz * result.fftSize / result.sampleRate),
    ),
  )
  const value = result.valuesDbfs[frameIndex * result.binCount + binIndex]
  return value !== undefined && Number.isFinite(value) ? value : fallbackDb
}

export function sampleSpectrumSeries(
  series: readonly SpectrumComparisonSeries[],
  timeSeconds: number,
  frequencyHz: number,
  fallbackDb: number,
): SpectrumSeriesSample[] {
  return series.flatMap((item) => isRenderableSpectrum(item.result)
    ? [{
        channelIndex: item.channelIndex,
        label: item.label,
        color: item.color,
        db: sampleSpectrumDb(item.result, timeSeconds, frequencyHz, fallbackDb),
      }]
    : [])
}
