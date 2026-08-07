import type { StftPreviewResult } from '../audio/analysis'
import { normalizeDb, spectrumColor } from './colorMap'

const MAX_PREVIEW_CHANNELS = 2
const DEFAULT_SAMPLES_PER_COLUMN = 24
const DEFAULT_TRACK_PREVIEW_VIEWPORT_RATIO = 0.5
const TRACK_PREVIEW_VIEWPORT_RATIO = 0.6
const TRACK_PREVIEW_CHROME_HEIGHT = 72
const MAX_TRACK_SPECTROGRAM_WIDTH = 1_024
const MAX_TRACK_SPECTROGRAM_HEIGHT = 384

export const MIN_TRACK_LANE_HEIGHT = 56

function trackLaneHeightForViewportRatio(viewportHeight: number, ratio: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return MIN_TRACK_LANE_HEIGHT
  }
  return Math.max(
    MIN_TRACK_LANE_HEIGHT,
    Math.floor((viewportHeight * ratio - TRACK_PREVIEW_CHROME_HEIGHT) / 2),
  )
}

export function defaultTrackLaneHeight(viewportHeight: number): number {
  return trackLaneHeightForViewportRatio(viewportHeight, DEFAULT_TRACK_PREVIEW_VIEWPORT_RATIO)
}

export function maximumTrackLaneHeight(viewportHeight: number): number {
  return trackLaneHeightForViewportRatio(viewportHeight, TRACK_PREVIEW_VIEWPORT_RATIO)
}

export interface TrackSpectrogramPixels {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8ClampedArray
}

export function buildTrackSpectrogramPixels(
  result: Pick<StftPreviewResult, 'frameCount' | 'binCount' | 'minDb' | 'maxDb' | 'valuesDbfs'>,
  responseDb: Float32Array | null = null,
  maximumWidth = MAX_TRACK_SPECTROGRAM_WIDTH,
  maximumHeight = MAX_TRACK_SPECTROGRAM_HEIGHT,
): TrackSpectrogramPixels | null {
  if (result.frameCount <= 0 || result.binCount <= 0) return null
  if (
    !Number.isSafeInteger(maximumWidth)
    || !Number.isSafeInteger(maximumHeight)
    || maximumWidth <= 0
    || maximumHeight <= 0
    || maximumWidth > 2_048
    || maximumHeight > 1_024
  ) {
    throw new RangeError('Track spectrogram dimensions exceed the bounded preview range')
  }
  if (result.valuesDbfs.length < result.frameCount * result.binCount) {
    throw new RangeError('Track spectrogram source matrix is incomplete')
  }
  if (responseDb && responseDb.length < result.binCount) {
    throw new RangeError('Track spectrogram response does not cover every frequency bin')
  }

  const width = Math.min(result.frameCount, maximumWidth)
  const height = Math.min(result.binCount, maximumHeight)
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let x = 0; x < width; x += 1) {
    const frame = width <= 1
      ? 0
      : Math.round((x / (width - 1)) * (result.frameCount - 1))
    for (let y = 0; y < height; y += 1) {
      const bin = height <= 1
        ? 0
        : Math.round((1 - y / (height - 1)) * (result.binCount - 1))
      const sourceDb = result.valuesDbfs[frame * result.binCount + bin] ?? result.minDb
      const valueDb = sourceDb + (responseDb?.[bin] ?? 0)
      const [red, green, blue] = spectrumColor(normalizeDb(
        valueDb,
        result.minDb,
        result.maxDb,
      ))
      const target = (y * width + x) * 4
      pixels[target] = red
      pixels[target + 1] = green
      pixels[target + 2] = blue
      pixels[target + 3] = 255
    }
  }
  return { width, height, pixels }
}

export interface TrackOverview {
  readonly mins: Float32Array
  readonly maxs: Float32Array
}

/**
 * Builds a bounded-cost visual overview without copying source PCM. Each
 * column samples a fixed number of frames from at most two source channels.
 */
export function buildTrackOverview(
  channels: readonly Float32Array[],
  columns: number,
  samplesPerColumn = DEFAULT_SAMPLES_PER_COLUMN,
): TrackOverview {
  if (!Number.isSafeInteger(columns) || columns <= 0 || columns > 4_096) {
    throw new RangeError('Track preview columns must be within [1, 4096]')
  }
  if (!Number.isSafeInteger(samplesPerColumn) || samplesPerColumn <= 0 || samplesPerColumn > 256) {
    throw new RangeError('Track preview samples per column must be within [1, 256]')
  }

  const mins = new Float32Array(columns)
  const maxs = new Float32Array(columns)
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  const length = sourceChannels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  )
  if (sourceChannels.length === 0 || !Number.isFinite(length) || length <= 0) {
    return { mins, maxs }
  }

  for (let column = 0; column < columns; column += 1) {
    const start = Math.floor((column / columns) * length)
    const end = Math.max(start + 1, Math.floor(((column + 1) / columns) * length))
    const span = Math.max(1, end - start)
    const sampleCount = Math.min(samplesPerColumn, span)
    let minimum = 1
    let maximum = -1

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const ratio = sampleCount <= 1 ? 0 : sample / (sampleCount - 1)
      const index = Math.min(length - 1, start + Math.floor(ratio * (span - 1)))
      for (const channel of sourceChannels) {
        const value = channel[index] ?? 0
        if (!Number.isFinite(value)) continue
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
    }

    mins[column] = minimum <= maximum ? minimum : 0
    maxs[column] = minimum <= maximum ? maximum : 0
  }

  return { mins, maxs }
}
