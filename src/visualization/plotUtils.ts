import type { StftPreviewResult } from '../audio/analysis'

export const PLOT_MARGIN = {
  top: 14,
  right: 18,
  bottom: 30,
  left: 54,
} as const

export function nearestFrameIndex(
  result: StftPreviewResult,
  timeSeconds: number,
): number {
  if (result.frameCount <= 1) return 0
  const times = result.timesSeconds
  let low = 0
  let high = times.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const value = times[middle] ?? 0
    if (value < timeSeconds) low = middle + 1
    else high = middle
  }
  const previous = Math.max(0, low - 1)
  return Math.abs((times[previous] ?? 0) - timeSeconds) <=
    Math.abs((times[low] ?? 0) - timeSeconds)
    ? previous
    : low
}

export function frequencyToUnit(
  frequency: number,
  minFrequency: number,
  maxFrequency: number,
  scale: 'linear' | 'log',
): number {
  if (maxFrequency <= minFrequency) return 0
  if (scale === 'linear') {
    return (frequency - minFrequency) / (maxFrequency - minFrequency)
  }
  const safeMinimum = Math.max(1, minFrequency)
  const safeFrequency = Math.max(safeMinimum, frequency)
  return (
    (Math.log10(safeFrequency) - Math.log10(safeMinimum)) /
    (Math.log10(maxFrequency) - Math.log10(safeMinimum))
  )
}

export function unitToFrequency(
  unit: number,
  minFrequency: number,
  maxFrequency: number,
  scale: 'linear' | 'log',
): number {
  if (scale === 'linear') {
    return minFrequency + unit * (maxFrequency - minFrequency)
  }
  const safeMinimum = Math.max(1, minFrequency)
  return 10 ** (
    Math.log10(safeMinimum) +
    unit * (Math.log10(maxFrequency) - Math.log10(safeMinimum))
  )
}

export function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return `${(frequency / 1000).toFixed(frequency >= 10_000 ? 0 : 1)}k`
  return `${Math.round(frequency)}`
}
